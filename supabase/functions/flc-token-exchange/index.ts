// flc-token-exchange — swaps an FLC auth-Lambda JWT for a Supabase-signed JWT
// carrying identity + church-scope claims, so RLS policies can read
// auth.jwt() ->> 'sub' / 'email' / 'flc_roles' / 'flc_scopes'.
//
// Verification strategy: INTROSPECTION, not signature checking. We never hold
// the FLC signing secret. Instead the presented token is forwarded to the FLC
// GraphQL API (the same backend the app queries), which verifies tokens
// server-side and answers "Unauthenticated" for forged/expired ones. If the
// API accepts the token, it is genuine — and the member's leads*/isAdminFor*
// edges come back from the LIVE graph, so the minted claims are both
// tamper-proof (an attacker can't edit graph edges by editing a token) and
// fresher than anything embedded in the FLC JWT at login time.
//
// The minted token keeps role='anon' ON PURPOSE: every existing RLS policy is
// `to anon`, so enabling the exchange changes nothing until individual
// policies are rewritten to consult the claims. Tighten table by table.
//
// Required secrets (supabase secrets set …):
//   FLC_GRAPHQL_URL     — the real FLC GraphQL endpoint (the value the
//                         frontend proxies to as /flc-graphql).
//   EXCHANGE_JWT_SECRET — the project's legacy JWT secret (Dashboard →
//                         Settings → API → JWT Secret), so PostgREST
//                         accepts the minted token.
//
// See README.md next to this file for the full enablement procedure.

import * as jose from 'https://esm.sh/jose@5.9.6'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const CHURCH_LEVELS = [
  'bacenta', 'governorship', 'council', 'stream', 'campus', 'oversight', 'denomination',
] as const

// Lean member lookup — role edges only ({ id name }), no ancestor chains:
// scope claims are (level, churchId) pairs; ancestor logic lives in Postgres
// (get_ancestor_scopes). Field names match src/utils/membersApi.queries.ts.
const EDGE_FIELDS = `
  id
  email
  leadsBacenta { id name }
  leadsGovernorship { id name }
  leadsCouncil { id name }
  leadsStream { id name }
  leadsCampus { id name }
  leadsOversight { id name }
  leadsDenomination { id name }
  isAdminForGovernorship { id name }
  isAdminForCouncil { id name }
  isAdminForStream { id name }
  isAdminForCampus { id name }
  isAdminForOversight { id name }
  isAdminForDenomination { id name }
`

const MEMBER_LOOKUP_QUERY = `
  query TokenExchangeLookup($id: ID!, $email: String!) {
    byId: members(where: { id_EQ: $id }, limit: 1) { ${EDGE_FIELDS} }
    byEmail: members(where: { email_EQ: $email }, limit: 1) { ${EDGE_FIELDS} }
  }
`

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

interface EdgeRef { id?: string; name?: string }
type Member = Record<string, EdgeRef[] | string | null | undefined>

/** { "<level>:<churchId>": "admin"|"leader" } from live graph edges.
 *  Admin wins when both edges target the same church. */
function scopesFromMember(member: Member): Record<string, string> {
  const out: Record<string, string> = {}
  for (const level of CHURCH_LEVELS) {
    const admins = member[`isAdminFor${cap(level)}`]
    if (Array.isArray(admins)) {
      for (const ref of admins) if (ref?.id) out[`${level}:${ref.id}`] = 'admin'
    }
    const leads = member[`leads${cap(level)}`]
    if (Array.isArray(leads)) {
      for (const ref of leads) if (ref?.id) out[`${level}:${ref.id}`] ??= 'leader'
    }
  }
  return out
}

/** Role strings derived from edges, mirroring memberToProfileRow():
 *  leads<Level> → leader<Level>, isAdminFor<Level> → admin<Level>. */
function rolesFromMember(member: Member): string[] {
  const roles = new Set<string>()
  for (const level of CHURCH_LEVELS) {
    const leads = member[`leads${cap(level)}`]
    if (Array.isArray(leads) && leads.some((r) => r?.id)) roles.add(`leader${cap(level)}`)
    const admins = member[`isAdminFor${cap(level)}`]
    if (Array.isArray(admins) && admins.some((r) => r?.id)) roles.add(`admin${cap(level)}`)
  }
  return [...roles]
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const graphqlUrl = Deno.env.get('FLC_GRAPHQL_URL')
  const exchangeSecret = Deno.env.get('EXCHANGE_JWT_SECRET')
  if (!graphqlUrl || !exchangeSecret) return json({ error: 'not_configured' }, 503)

  let token: string | null = null
  try {
    const body = await req.json()
    if (typeof body?.token === 'string') token = body.token
  } catch { /* no/invalid body */ }
  if (!token) return json({ error: 'token_required' }, 400)

  // Unverified decode — used only to know WHO to look up. Authority comes
  // from the graph accepting the token below; a tampered token is rejected
  // by the FLC API's own signature check.
  let payload: Record<string, unknown>
  try {
    payload = jose.decodeJwt(token) as Record<string, unknown>
  } catch {
    return json({ error: 'malformed_token' }, 400)
  }
  const userId = (payload.userId ?? payload.sub) as string | undefined
  const payloadEmail = typeof payload.email === 'string' ? payload.email.toLowerCase().trim() : ''
  if (!userId) return json({ error: 'token_missing_user_id' }, 401)

  // Introspect: the FLC API is the verifier.
  let gqlBody: { data?: { byId?: Member[]; byEmail?: Member[] }; errors?: Array<{ message?: string }> }
  try {
    const res = await fetch(graphqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: MEMBER_LOOKUP_QUERY,
        variables: { id: userId, email: payloadEmail },
      }),
    })
    if (!res.ok) return json({ error: 'graph_unavailable' }, 503)
    gqlBody = await res.json()
  } catch {
    return json({ error: 'graph_unavailable' }, 503)
  }

  if (gqlBody.errors?.length && !gqlBody.data) {
    // The graph is the trust anchor: it answers the literal message
    // "Unauthenticated" for a forged/expired/missing token (see
    // membersApi.queries.ts:4) — that specific signal is the only thing that
    // proves the credential itself is bad. Any other GraphQL-level error
    // (schema bug, resolver exception, transient upstream hiccup) is not
    // evidence the token is invalid, and treating it as one wrongly forces a
    // real, currently-logged-in user through the anon-key fallback / a
    // "you're not in scope" dead end instead of just retrying. Surface those
    // as a retryable failure instead.
    const isAuthRejection = gqlBody.errors.some(
      (e) => typeof e?.message === 'string' && /unauthenticated|forbidden/i.test(e.message),
    )
    if (isAuthRejection) return json({ error: 'invalid_token' }, 401)
    return json({ error: 'graph_error' }, 503)
  }

  const member = gqlBody.data?.byId?.[0] ?? gqlBody.data?.byEmail?.[0] ?? null

  // Token accepted but no graph node (e.g. Supabase-table-only superadmin):
  // still verified — mint with payload-derived identity and empty scopes.
  const flcScopes = member ? scopesFromMember(member) : {}
  const flcRoles = member
    ? rolesFromMember(member)
    : (Array.isArray(payload.roles) ? (payload.roles as string[]) : [])
  const email = (typeof member?.email === 'string' && member.email)
    ? member.email.toLowerCase().trim()
    : payloadEmail || null

  const nowSec = Math.floor(Date.now() / 1000)
  const flcExp = typeof payload.exp === 'number' ? payload.exp : nowSec + 3600
  const exp = Math.min(flcExp, nowSec + 3600)
  if (exp <= nowSec) return json({ error: 'token_expired' }, 401)

  const minted = await new jose.SignJWT({
    role: 'anon', // keeps existing `to anon` policies working — see header
    email,
    flc_roles: flcRoles,
    flc_scopes: flcScopes,
    // member_profiles is keyed by auth userId (= sub); checkin_records and
    // event_scope_members store the graph node id — expose both for policies.
    graph_member_id: typeof member?.id === 'string' ? member.id : null,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer('flc-token-exchange')
    .setIssuedAt(nowSec)
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(exchangeSecret))

  return json({ access_token: minted, expires_at: exp })
})
