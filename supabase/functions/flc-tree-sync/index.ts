// flc-tree-sync — mirrors the FL Admin Portal church tree and servant edges
// into graph_churches / graph_members / graph_servant_edges (migration 046).
//
// Why a server function, and why the caller's token
// -------------------------------------------------
// The portal filters every church read by the caller's servant edges
// (`@churchScoped` → allowedChurchIds). Only a token whose edges reach the
// Denomination sees the whole tree. Browsers used to write Hineni's copy from
// whatever slice their user could see; this function is now the ONLY writer,
// and it refuses callers without a denomination-level edge. The SQL apply
// additionally refuses a snapshot much smaller than what is stored, so a
// partial view can never end edges it could not see.
//
// When the portal team issues Hineni a read-only service token, set it as
// FLC_SERVICE_TOKEN and schedule this function; the caller check is then
// skipped for scheduled runs (see resolveToken).
//
// Secrets: FLC_GRAPHQL_URL (shared with flc-token-exchange). SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are injected by the platform.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const PAGE_SIZE = 250
const CONCURRENCY = 3
const GRAPH_TIMEOUT_MS = 25_000
const MAX_PAGES = 400 // 100k rows — a runaway guard, not a real limit

type Level = 'denomination' | 'oversight' | 'campus' | 'stream' | 'council' | 'governorship' | 'bacenta'
type EdgeType = 'LEADS' | 'DEPUTY_LEADS' | 'IS_ADMIN_FOR'

interface ChurchRow { id: string; level: Level; name: string | null; parent_id: string | null; labels: string[] }
interface MemberRow {
  id: string; email: string | null; title: string | null; first_name: string | null
  last_name: string | null; phone: string | null; picture_url: string | null
}
interface EdgeRow { member_id: string; church_id: string; level: Level; edge_type: EdgeType }

// Root list field, and the field naming each level's parent (portal SDL).
const LEVELS: Array<{ level: Level; root: string; parent: string | null; extra?: string }> = [
  { level: 'denomination', root: 'denominations', parent: null },
  { level: 'oversight',    root: 'oversights',    parent: 'denomination' },
  { level: 'campus',       root: 'campuses',      parent: 'oversight' },
  { level: 'stream',       root: 'streams',       parent: 'campus' },
  { level: 'council',      root: 'councils',      parent: 'stream' },
  { level: 'governorship', root: 'governorships', parent: 'council' },
  // DEPUTY_LEADS is only exposed from the Bacenta side (Bacenta.deputyLeader).
  { level: 'bacenta',      root: 'bacentas',      parent: 'governorship', extra: 'labels deputyLeader { id }' },
]

// Member-side edge lists: field → (level, edge type). No isAdminForBacenta —
// the portal has no Bacenta admin role (edgeToRole returns null for it).
const MEMBER_EDGES: Array<{ field: string; level: Level; type: EdgeType }> = [
  { field: 'leadsBacenta',           level: 'bacenta',      type: 'LEADS' },
  { field: 'leadsGovernorship',      level: 'governorship', type: 'LEADS' },
  { field: 'leadsCouncil',           level: 'council',      type: 'LEADS' },
  { field: 'leadsStream',            level: 'stream',       type: 'LEADS' },
  { field: 'leadsCampus',            level: 'campus',       type: 'LEADS' },
  { field: 'leadsOversight',         level: 'oversight',    type: 'LEADS' },
  { field: 'leadsDenomination',      level: 'denomination', type: 'LEADS' },
  { field: 'isAdminForGovernorship', level: 'governorship', type: 'IS_ADMIN_FOR' },
  { field: 'isAdminForCouncil',      level: 'council',      type: 'IS_ADMIN_FOR' },
  { field: 'isAdminForStream',       level: 'stream',       type: 'IS_ADMIN_FOR' },
  { field: 'isAdminForCampus',       level: 'campus',       type: 'IS_ADMIN_FOR' },
  { field: 'isAdminForOversight',    level: 'oversight',    type: 'IS_ADMIN_FOR' },
  { field: 'isAdminForDenomination', level: 'denomination', type: 'IS_ADMIN_FOR' },
]

const MEMBERS_PAGE_QUERY = `
  query TreeSyncMembers($limit: Int!, $offset: Int!) {
    members(limit: $limit, offset: $offset, sort: [{ id: ASC }]) {
      id email firstName lastName phoneNumber whatsappNumber pictureUrl
      title { name }
      ${MEMBER_EDGES.map((e) => `${e.field} { id }`).join('\n      ')}
    }
  }
`

const CALLER_QUERY = `
  query TreeSyncCaller($id: ID!, $email: String!) {
    byId: members(where: { id_EQ: $id }, limit: 1) { id leadsDenomination { id } isAdminForDenomination { id } }
    byEmail: members(where: { email_EQ: $email }, limit: 1) { id leadsDenomination { id } isAdminForDenomination { id } }
  }
`

class GraphError extends Error {
  constructor(message: string, readonly authRejected = false) { super(message) }
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

async function gql<T>(url: string, token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  })
  if (!res.ok) throw new GraphError(`graph HTTP ${res.status}`)
  const body = await res.json()
  if (body.errors?.length) {
    const msg = String(body.errors[0]?.message ?? 'graph error')
    throw new GraphError(msg, /unauthenticated|forbidden/i.test(msg))
  }
  return body.data as T
}

/** Every page of a sorted list, CONCURRENCY pages at a time, until a short
 *  page. Any failed page aborts the whole sync — a snapshot with a hole in it
 *  is worse than no snapshot. */
async function fetchAllPages<T>(fetchPage: (offset: number) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []
  for (let page = 0; page < MAX_PAGES; page += CONCURRENCY) {
    const batch = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) => fetchPage((page + i) * PAGE_SIZE)),
    )
    for (const rows of batch) out.push(...rows)
    if (batch.some((rows) => rows.length < PAGE_SIZE)) return out
  }
  throw new GraphError('pagination did not terminate')
}

async function pullSnapshot(url: string, token: string) {
  const churches: ChurchRow[] = []
  const edges: EdgeRow[] = []
  const deputyIds = new Set<string>()

  for (const lvl of LEVELS) {
    const parentSel = lvl.parent ? `${lvl.parent} { id }` : ''
    const query = `
      query TreeSync_${lvl.level}($limit: Int!, $offset: Int!) {
        ${lvl.root}(limit: $limit, offset: $offset, sort: [{ id: ASC }]) { id name ${parentSel} ${lvl.extra ?? ''} }
      }`
    const rows = await fetchAllPages(async (offset) =>
      (await gql<Record<string, any[]>>(url, token, query, { limit: PAGE_SIZE, offset }))[lvl.root] ?? [])
    for (const r of rows) {
      if (!r?.id) continue
      churches.push({
        id: r.id,
        level: lvl.level,
        name: r.name ?? null,
        parent_id: lvl.parent ? (r[lvl.parent]?.id ?? null) : null,
        labels: Array.isArray(r.labels) ? r.labels : [],
      })
      if (r.deputyLeader?.id) {
        edges.push({ member_id: r.deputyLeader.id, church_id: r.id, level: 'bacenta', edge_type: 'DEPUTY_LEADS' })
        deputyIds.add(r.deputyLeader.id)
      }
    }
  }

  const rawMembers = await fetchAllPages(async (offset) =>
    (await gql<{ members: any[] }>(url, token, MEMBERS_PAGE_QUERY, { limit: PAGE_SIZE, offset })).members ?? [])

  const members: MemberRow[] = []
  let scanned = 0
  for (const m of rawMembers) {
    if (!m?.id) continue
    scanned++
    let servant = deputyIds.has(m.id)
    for (const e of MEMBER_EDGES) {
      for (const ref of Array.isArray(m[e.field]) ? m[e.field] : []) {
        if (!ref?.id) continue
        edges.push({ member_id: m.id, church_id: ref.id, level: e.level, edge_type: e.type })
        servant = true
      }
    }
    if (!servant) continue
    members.push({
      id: m.id,
      email: typeof m.email === 'string' ? m.email : null,
      title: (Array.isArray(m.title) ? m.title[0]?.name : m.title?.name) ?? null,
      first_name: m.firstName ?? null,
      last_name: m.lastName ?? null,
      phone: m.phoneNumber || m.whatsappNumber || null,
      picture_url: m.pictureUrl ?? null,
    })
  }
  return { churches, members, edges, scanned }
}

/** Returns the token to read the graph with, or a Response to send back. */
async function resolveToken(req: Request, graphUrl: string): Promise<{ token: string; by: string } | Response> {
  let body: any = null
  try { body = await req.json() } catch { /* empty */ }
  const token = typeof body?.token === 'string' ? body.token : null

  // Scheduled / service runs: no caller check, the service token is trusted.
  const service = Deno.env.get('FLC_SERVICE_TOKEN')
  const syncKey = Deno.env.get('TREE_SYNC_KEY')
  if (!token && service && syncKey && req.headers.get('x-tree-sync-key') === syncKey) {
    return { token: service, by: 'service' }
  }
  if (!token) return json({ ok: false, reason: 'token_required' }, 400)

  // Caller must hold a Denomination edge: only that reach sees the whole tree.
  // The decode only tells us WHO to look up; the graph accepting the token in
  // the query below is what proves it genuine.
  let payload: Record<string, unknown> = {}
  try {
    const part = token.split('.')[1]
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')
    payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))))
  } catch { /* malformed — handled below */ }
  const id = String(payload.userId ?? payload.sub ?? '')
  const email = typeof payload.email === 'string' ? payload.email.toLowerCase().trim() : ''
  if (!id && !email) return json({ ok: false, reason: 'malformed_token' }, 400)

  try {
    const data = await gql<{ byId: any[]; byEmail: any[] }>(graphUrl, token, CALLER_QUERY, { id, email })
    const me = data.byId?.[0] ?? data.byEmail?.[0]
    const reach = (me?.leadsDenomination?.length ?? 0) + (me?.isAdminForDenomination?.length ?? 0)
    if (!me || reach === 0) return json({ ok: false, reason: 'denomination_role_required' }, 403)
    return { token, by: `member:${me.id}` }
  } catch (err) {
    if (err instanceof GraphError && err.authRejected) return json({ ok: false, reason: 'invalid_token' }, 401)
    return json({ ok: false, reason: 'graph_unavailable' }, 503)
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ ok: false, reason: 'method_not_allowed' }, 405)

  const graphUrl = Deno.env.get('FLC_GRAPHQL_URL')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!graphUrl || !supabaseUrl || !serviceKey) return json({ ok: false, reason: 'not_configured' }, 503)

  const started = performance.now()
  const who = await resolveToken(req, graphUrl)
  if (who instanceof Response) return who

  let snapshot
  try {
    snapshot = await pullSnapshot(graphUrl, who.token)
  } catch (err) {
    console.error('[flc-tree-sync] pull failed:', err instanceof Error ? err.message : err)
    const authRejected = err instanceof GraphError && err.authRejected
    return json({ ok: false, reason: authRejected ? 'invalid_token' : 'graph_pull_failed',
                  detail: err instanceof Error ? err.message : String(err) }, authRejected ? 401 : 502)
  }
  const pulledMs = Math.round(performance.now() - started)

  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/apply_graph_snapshot`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({
      p_churches: snapshot.churches,
      p_members: snapshot.members,
      p_edges: snapshot.edges,
      p_triggered_by: who.by,
    }),
  })
  const applied = await res.json().catch(() => null)
  const summary = {
    ...(applied && typeof applied === 'object' ? applied : { ok: false, reason: 'apply_failed' }),
    scanned_members: snapshot.scanned,
    pull_ms: pulledMs,
    total_ms: Math.round(performance.now() - started),
  }
  console.log(JSON.stringify({ fn: 'flc-tree-sync', by: who.by, ...summary }))
  return json(summary, res.ok && applied?.ok ? 200 : res.ok ? 409 : 500)
})
