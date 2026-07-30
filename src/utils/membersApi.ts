// FLC member directory adapter — wraps VITE_MEMBER_GRAPHQL_URL.
//
// Reads require a JWT bearer (prod/dev return "Unauthenticated" without one).
// The client() below attaches accessToken from localStorage on every request.
//
// The app's universe is members who lead OR admin something — regular
// members are excluded. See membersApi.queries.js for the OR-filter that
// enforces this in every list query.

import { GraphQLClient } from 'graphql-request'
import { SCOPE_LEVELS } from './auth.js'
import { getUserAdminScopesFromJwt } from './userScope'
import {
  cacheHierarchyChain,
  cacheHierarchyChildren,
  fetchAncestorScopesFromDb,
} from './hierarchyCache'
import {
  GET_MEMBER_BY_ID,
  GET_MEMBER_BY_EMAIL,
  GET_MEMBER_BY_ID_OR_EMAIL,
  SCOPE_QUERIES,
  ANCESTOR_QUERIES,
  CHILD_COUNT_QUERIES,
  CHILD_LIST_QUERIES,
  CHILD_LEADER_QUERIES,
  GET_ALL_MEMBERS_PAGE,
  SEARCH_CHURCHES,
  SEARCH_MEMBERS_BY_NAME,
  SEARCH_MEMBERS_BY_NAME_LEAN,
} from './membersApi.queries.js'
import { createBoundedFetch, isAuthFailure, isNetworkError } from './network'
import { apiOrigin } from './apiOrigin'
import { toast } from '../components/Toast'

function graphqlEndpoint() {
  // Always use the same-origin /flc-graphql path (or VITE_API_ORIGIN on native).
  // Dev    → Vite proxy (vite.config.js) forwards to the FLC GraphQL endpoint.
  // Prod   → Vercel rewrite (vercel.json) forwards it server-side.
  // Native → build:mobile sets VITE_API_ORIGIN to the deployed Vercel origin.
  return `${apiOrigin()}/flc-graphql`
}

// GraphQL client factory. The endpoint is authenticated — without a bearer
// token Neo4j-GraphQL applies a denomination-only filter that hides every
// child node, which silently breaks every leader-visibility flow.
//
// The token can rotate during a session (refresh flow), so we read it on
// each call and rebuild only when it changes. GraphQLClient is cheap to
// construct (it doesn't open a connection up front) so this is fine.
let _client: GraphQLClient | null = null
let _clientToken: string | null = null
function client(): GraphQLClient {
  const token = typeof window !== 'undefined'
    ? (window.localStorage?.getItem('accessToken') ?? null)
    : null
  if (!_client || _clientToken !== token) {
    _client = new GraphQLClient(graphqlEndpoint(), {
      // retryUnsafe is deliberately OFF. GraphQL requests are POSTs, and
      // retrying them under load is how a slow upstream becomes a dead one:
      // Neo4j slows → requests hit the 10s timeout → every client retries →
      // offered load doubles → nothing recovers. Reads here are idempotent in
      // principle, but the failure mode we actually hit is saturation, and
      // retrying is exactly the wrong response to saturation.
      //
      // A failed graph read degrades gracefully everywhere it is used (callers
      // fall back to Supabase profiles or to JWT scopes), so one clean failure
      // beats two that make the outage worse for everyone else.
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      fetch: createBoundedFetch({ timeoutMs: 10_000, retries: 0 }),
    })
    _clientToken = token
  }
  return _client
}

/**
 * GraphQL request with portal-aligned auth/network policy:
 *  - On auth failure: refresh once, rebuild client, retry. Real unauthorized
 *    clears the session; network failure toasts once (stable id) and keeps tokens.
 *  - On transport error: one quiet retry, then a single deduped toast.
 *  - Never retries on saturation cascades beyond that single attempt.
 */
async function gqlRequest<T = any>(
  document: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const run = () => client().request<T>(document, variables as any)

  try {
    return await run()
  } catch (err) {
    if (isAuthFailure(err)) {
      const { refreshSessionDetailed, logout } = await import('./auth')
      const refreshed = await refreshSessionDetailed()
      if (refreshed.status === 'ok') {
        _client = null
        _clientToken = null
        return await run()
      }
      if (refreshed.status === 'unauthorized') {
        logout()
        toast('Your session expired. Please sign in again.', 'error', { id: 'auth:expired' })
      } else {
        toast("The network is struggling right now. Please try again.", 'error', { id: 'gql:network' })
      }
      throw err
    }

    if (isNetworkError(err)) {
      try {
        await new Promise((r) => setTimeout(r, 300 + Math.random() * 400))
        return await run()
      } catch (err2) {
        toast("The network is struggling right now. Please try again.", 'error', { id: 'gql:network' })
        throw err2
      }
    }

    throw err
  }
}

// ─── Module-level caches ──────────────────────────────────────────────────
// All graph queries are idempotent reads over data that changes at most a
// few times a day. Caching them here means subsequent page opens are instant
// (served from memory) and parallel callers (EventDashboard + FullReport
// opening simultaneously) never fire duplicate network requests.

const SCOPE_MEMBERS_TTL = 5 * 60 * 1000   // 5 min
const ANCESTORS_TTL     = 10 * 60 * 1000  // 10 min (hierarchy almost never changes)

// getMembersInScope cache
interface ScopeMembersEntry { data: any[]; ts: number }
const scopeMembersCache   = new Map<string, ScopeMembersEntry>()
const scopeMembersPending = new Map<string, Promise<any[]>>()

// resolveCurrentMember caches — positive hits are permanent for the session;
// null hits are cached with a short TTL so a transient graph failure doesn't
// permanently exclude a user without forcing a page reload.
const MEMBER_NULL_TTL = 2 * 60 * 1000  // 2 min

const memberByUserCache    = new Map<string, any>()       // positive hits
const memberByUserNullTs   = new Map<string, number>()    // null-hit timestamps
const memberByUserPending  = new Map<string, Promise<any>>()

// ─── Scope chains ───────────────────────────────────────────────────────────
// A member can hold role edges in SEVERAL hierarchies at once — e.g. lead a
// Bacenta under Council C1 while also administering Council C2 in a different
// stream. Each such edge implies its own complete, real path up to the
// denomination.
//
// These MUST be kept apart. The previous implementation resolved each level
// independently (leader edge → admin edge → walk-up from the level below),
// which let the chain jump hierarchies mid-walk and produced a path that
// exists nowhere in the graph: Bacenta B → Governorship G1 → Council C2,
// where G1's real parent is C1. That fabricated path was then written to
// member_profiles, to localStorage, and — worst — to the shared
// church_hierarchy table, where it corrupted descendant expansion for every
// other user.
//
// buildScopeChains keeps one chain per edge. Every entry within a chain is a
// genuine parent of the one below it, because it is read from the parent
// objects the graph itself embedded (see MEMBER_FIELDS).

export type ScopeChainSource = 'leader' | 'admin' | 'member'

export interface ScopeChainNode { id: string; name: string | null }

export interface ScopeChain {
  /** Which kind of edge produced this chain. */
  source: ScopeChainSource
  /** Level of the edge itself — the most specific level in the chain. */
  level: string
  /** level → node, from `level` up to denomination. Internally consistent. */
  path: Record<string, ScopeChainNode>
}

/** Church levels, lowest → highest. Excludes special_group, which sits
 *  outside the church tree and has no parent chain. */
const CHURCH_LEVELS: string[] = [
  'bacenta', 'governorship', 'council', 'stream', 'campus', 'oversight', 'denomination',
]

/** Walk from `node` (at `startLevel`) up through the parent objects the graph
 *  embedded, collecting one node per level. Stops at the first missing link —
 *  a partial chain is correct-but-incomplete, which is safe; a guessed link
 *  would be neither. */
function chainFromNode(node: any, startLevel: string): Record<string, ScopeChainNode> | null {
  if (!node?.id) return null
  const path: Record<string, ScopeChainNode> = {}
  let cur: any = node
  let idx = CHURCH_LEVELS.indexOf(startLevel)
  if (idx < 0) return null
  while (cur?.id && idx < CHURCH_LEVELS.length) {
    path[CHURCH_LEVELS[idx]] = { id: cur.id, name: cur.name ?? null }
    idx++
    if (idx >= CHURCH_LEVELS.length) break
    cur = cur[CHURCH_LEVELS[idx]] ?? null
  }
  return path
}

/** Every coherent hierarchy chain this member belongs to, one per role edge.
 *
 *  Ordered most-specific-first so `[0]` is the natural "primary" identity —
 *  the same rule the FL Admin Portal uses when it defaults its Church-in-Focus
 *  picker to the user's lowest role. Ties break leader-before-admin, then by
 *  id, so the ordering is deterministic across logins: the graph does not
 *  guarantee array order, and the old `pickFirst` let the stored chain flip
 *  from one session to the next. */
export function buildScopeChains(m: any): ScopeChain[] {
  const chains: ScopeChain[] = []
  const seen = new Set<string>()

  const addEdges = (arr: any, level: string, source: ScopeChainSource) => {
    for (const node of Array.isArray(arr) ? arr : []) {
      const key = `${source}:${level}:${node?.id}`
      if (!node?.id || seen.has(key)) continue
      const path = chainFromNode(node, level)
      if (!path) continue
      seen.add(key)
      chains.push({ source, level, path })
    }
  }

  addEdges(m?.leadsBacenta,             'bacenta',      'leader')
  addEdges(m?.leadsGovernorship,        'governorship', 'leader')
  addEdges(m?.isAdminForGovernorship,   'governorship', 'admin')
  addEdges(m?.leadsCouncil,             'council',      'leader')
  addEdges(m?.isAdminForCouncil,        'council',      'admin')
  addEdges(m?.leadsStream,              'stream',       'leader')
  addEdges(m?.isAdminForStream,         'stream',       'admin')
  addEdges(m?.leadsCampus,              'campus',       'leader')
  addEdges(m?.isAdminForCampus,         'campus',       'admin')
  addEdges(m?.leadsOversight,           'oversight',    'leader')
  addEdges(m?.isAdminForOversight,      'oversight',    'admin')
  addEdges(m?.leadsDenomination,        'denomination', 'leader')
  addEdges(m?.isAdminForDenomination,   'denomination', 'admin')

  // No role edges at all — fall back to personal membership. MEMBER_FIELDS
  // does not embed parents on `bacenta`, so this chain is bacenta-only. That
  // is a real limitation of the query, not a merge: one true node beats seven
  // guessed ones.
  if (chains.length === 0 && m?.bacenta?.id) {
    chains.push({
      source: 'member',
      level: 'bacenta',
      path: { bacenta: { id: m.bacenta.id, name: m.bacenta.name ?? null } },
    })
  }

  const sourceRank: Record<ScopeChainSource, number> = { leader: 0, admin: 1, member: 2 }
  return chains.sort((a, b) => {
    const levelDiff = CHURCH_LEVELS.indexOf(a.level) - CHURCH_LEVELS.indexOf(b.level)
    if (levelDiff !== 0) return levelDiff
    const sourceDiff = sourceRank[a.source] - sourceRank[b.source]
    if (sourceDiff !== 0) return sourceDiff
    return (a.path[a.level]?.id ?? '').localeCompare(b.path[b.level]?.id ?? '')
  })
}

// ─── Convert a Member node into the shape we cache in member_profiles ──────
// The flat *_id / *_name columns hold the member's PRIMARY chain only — the
// single most-specific hierarchy they belong to. They are deliberately NOT a
// summary of everywhere the member has a role; a member in two hierarchies
// cannot be described by one set of flat columns, and pretending otherwise is
// what produced the fabricated paths this function used to write.
//
// The full picture lives in `scope_paths` (every chain, tagged with the edge
// that produced it). Read that when you need to answer "is this member within
// scope X" for any X. Read the flat columns only when you need the one
// canonical unit to display.
//
// Note a leader's `Member.bacenta` is where they personally attend, which may
// differ from the bacenta they LEAD. Leadership wins: event visibility follows
// role edges, so the cached row must agree with that.
export function memberToProfileRow(m) {
  const chains = buildScopeChains(m)
  const primary = chains[0]?.path ?? {}

  const bacenta      = primary.bacenta      ?? null
  const governorship = primary.governorship ?? null
  const council      = primary.council      ?? null
  const stream       = primary.stream       ?? null
  const campus       = primary.campus       ?? null
  const oversight    = primary.oversight    ?? null
  const denomination = primary.denomination ?? null

  return {
    id: m.id,
    // Hineni's operational universe is leaders/admins. Graph deactivation is
    // only allowed after those relationships are removed, so relationship
    // eligibility is the strongest lifecycle signal available without a
    // Graph schema change.
    is_active: isLeaderOrAdmin(m),
    email: m.email || null,
    title: (Array.isArray(m.title) ? m.title[0]?.name : m.title) || null,
    first_name: m.firstName || null,
    last_name: m.lastName || null,
    phone: m.phoneNumber || m.whatsappNumber || null,
    picture_url: m.pictureUrl || null,
    roles: derivedRoles(m),
    bacenta_id:      bacenta?.id      || null,  bacenta_name:      bacenta?.name      || null,
    governorship_id: governorship?.id || null,  governorship_name: governorship?.name || null,
    council_id:      council?.id      || null,  council_name:      council?.name      || null,
    stream_id:       stream?.id       || null,  stream_name:       stream?.name       || null,
    campus_id:       campus?.id       || null,  campus_name:       campus?.name       || null,
    oversight_id:    oversight?.id    || null,  oversight_name:    oversight?.name    || null,
    denomination_id: denomination?.id || null,  denomination_name: denomination?.name || null,
    // Every level this member touches, flattened. Answers "is this member
    // inside scope X" without implying the levels form one chain.
    scope_ids: scopeIdsFromChains(chains),
    // The chains themselves, pairing preserved. This is the only field that
    // can distinguish "Council C1 under Stream S1" from "Council C2 under
    // Stream S2" for a member who holds edges in both.
    scope_paths: chains,
  }
}

/** Per-level union of every id across every chain.
 *  Shape: { campus: ["id1","id2"], stream: ["id1"], … }
 *
 *  Kept for backward compatibility with consumers written against migration
 *  020. It is lossy by construction — a union tells you a member touches
 *  Council C1 and C2 and Streams S1 and S2, but not which council sits under
 *  which stream. Prefer `scope_paths` in new code. */
function scopeIdsFromChains(chains: ScopeChain[]): Record<string, string[]> {
  const acc: Record<string, Set<string>> = {}
  for (const chain of chains) {
    for (const [level, node] of Object.entries(chain.path)) {
      if (!node?.id) continue
      ;(acc[level] ??= new Set()).add(node.id)
    }
  }
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, [...v]]))
}

// Synthesize the role strings used in the rest of the app (matches the
// `leader<Level>` / `admin<Level>` convention from getLevelFromRoles).
function derivedRoles(m) {
  const roles = new Set()
  const add = (arr, role) => {
    if (Array.isArray(arr) && arr.length > 0) roles.add(role)
  }
  add(m.leadsBacenta,             'leaderBacenta')
  add(m.leadsGovernorship,        'leaderGovernorship')
  add(m.leadsCouncil,             'leaderCouncil')
  add(m.leadsStream,              'leaderStream')
  add(m.leadsCampus,              'leaderCampus')
  add(m.leadsOversight,           'leaderOversight')
  add(m.leadsDenomination,        'leaderDenomination')
  add(m.isAdminForGovernorship,   'adminGovernorship')
  add(m.isAdminForCouncil,        'adminCouncil')
  add(m.isAdminForStream,         'adminStream')
  add(m.isAdminForCampus,         'adminCampus')
  add(m.isAdminForOversight,      'adminOversight')
  add(m.isAdminForDenomination,   'adminDenomination')
  return [...roles]
}

// ─── getMemberById ─────────────────────────────────────────────────────────
// Returns the matching Member node, or null if not found.
export async function getMemberById(id) {
  const data = await gqlRequest(GET_MEMBER_BY_ID, { id })
  return data?.members?.[0] || null
}

// ─── getMemberByEmail ──────────────────────────────────────────────────────
export async function getMemberByEmail(email) {
  const data = await gqlRequest(GET_MEMBER_BY_EMAIL, { email })
  return data?.members?.[0] || null
}

export async function getMemberByIdOrEmail(id: string, email: string) {
  const data = await gqlRequest<{ members: any[] }>(
    GET_MEMBER_BY_ID_OR_EMAIL,
    { id, email },
  )
  const members = data?.members || []
  return members.find((member) => member?.id === id)
    || members.find((member) => member?.email?.toLowerCase() === email.toLowerCase())
    || null
}

// ─── resolveCurrentMember(user) ────────────────────────────────────────────
// Best-effort lookup of the logged-in user in the FLC member graph. When both
// identifiers are available, one OR query checks auth ID + email in a single
// round trip (the auth and graph systems do not always share IDs).
//
// Caching:
//   • Positive hits are cached permanently for the session.
//   • Null hits are cached for MEMBER_NULL_TTL so a temporary graph outage
//     doesn't fire duplicate requests on every screen mount — but the user
//     can recover by waiting ~2 min without a reload.
//   • In-flight dedup: concurrent callers share the same Promise.
export async function resolveCurrentMember(user) {
  if (!user) return null
  const cacheKey = user.userId || user.email
  if (!cacheKey) return null

  // Positive cache hit
  if (memberByUserCache.has(cacheKey)) return memberByUserCache.get(cacheKey)
  // Null cache hit (recent confirmed miss — don't re-query yet)
  const nullTs = memberByUserNullTs.get(cacheKey)
  if (nullTs && Date.now() - nullTs < MEMBER_NULL_TTL) return null
  // In-flight dedup
  if (memberByUserPending.has(cacheKey)) return memberByUserPending.get(cacheKey)

  const p = (async () => {
    if (user.userId && user.email) {
      return getMemberByIdOrEmail(user.userId, user.email)
    }
    if (user.userId) return getMemberById(user.userId)
    if (user.email) return getMemberByEmail(user.email)
    return null
  })().then((member) => {
    memberByUserPending.delete(cacheKey)
    if (member) {
      memberByUserCache.set(cacheKey, member)
    } else {
      memberByUserNullTs.set(cacheKey, Date.now())
    }
    return member
  }).catch((err) => {
    memberByUserPending.delete(cacheKey)
    throw err
  })

  memberByUserPending.set(cacheKey, p)
  return p
}

/** Drop cached graph lookups so the next resolve hits the network (login / resync). */
export function clearResolveCurrentMemberCache(user?: { userId?: string; email?: string }) {
  if (user) {
    const key = user.userId || user.email
    if (key) {
      memberByUserCache.delete(key)
      memberByUserNullTs.delete(key)
      memberByUserPending.delete(key)
    }
    return
  }
  memberByUserCache.clear()
  memberByUserNullTs.clear()
  memberByUserPending.clear()
}

// ─── getMembersInScope({ level, churchId }) ─────────────────────────────────
// Returns every leader/admin within the given scope's hierarchy, including
// the scope itself.
//
// Results are cached for SCOPE_MEMBERS_TTL and in-flight requests are
// deduplicated, so opening EventDashboard + FullReport simultaneously (or
// navigating back to a dashboard you've visited recently) costs zero extra
// graph round-trips.
export async function getMembersInScope({ level, churchId }): Promise<any[]> {
  if (!SCOPE_LEVELS.includes(level)) {
    throw new Error(`Unknown scope level: ${level}`)
  }
  const key = `${level}:${churchId}`
  const hit = scopeMembersCache.get(key)
  if (hit && Date.now() - hit.ts < SCOPE_MEMBERS_TTL) return hit.data
  if (scopeMembersPending.has(key)) return scopeMembersPending.get(key)!

  const query = SCOPE_QUERIES[level]
  if (!query) throw new Error(`No scope query for level: ${level}`)

  const p = gqlRequest(query, { churchId })
    .then((data: any) => {
      const result: any[] = (data?.members || []).filter(isLeaderOrAdmin)
      scopeMembersCache.set(key, { data: result, ts: Date.now() })
      scopeMembersPending.delete(key)
      return result
    })
    .catch((err) => {
      scopeMembersPending.delete(key)
      throw err
    })
  scopeMembersPending.set(key, p)
  return p
}

// ─── getAllLeadersAndAdmins(onProgress?) ────────────────────────────────────
// Pages through every Member in the FLC graph (no scope filter) and returns
// just the leaders/admins. Used by the super-admin "Sync Members" tool to
// pre-populate Supabase with everyone who could log in or appear in a
// dashboard — independent of any single denomination/stream/etc.
//
// `onProgress` is called after each page with the running totals so the UI
// can show "Fetched N so far…". Bypasses caching — this is an explicit
// admin action that should always read the graph fresh.
export async function getAllLeadersAndAdmins(
  onProgress?: (fetched: number, kept: number) => void,
): Promise<{ eligible: any[]; ineligibleIds: string[]; scanned: number }> {
  const PAGE_SIZE = 500
  const kept: any[] = []
  const ineligibleIds: string[] = []
  let offset = 0
  let fetched = 0
  // Hard cap to avoid runaway loops if the server ignores offset.
  const MAX_PAGES = 200
  for (let page = 0; page < MAX_PAGES; page++) {
    const data: any = await gqlRequest(GET_ALL_MEMBERS_PAGE, {
      limit: PAGE_SIZE, offset,
    })
    const batch: any[] = data?.members || []
    fetched += batch.length
    for (const m of batch) {
      if (isLeaderOrAdmin(m)) kept.push(m)
      else if (m?.id) ineligibleIds.push(m.id)
    }
    onProgress?.(fetched, kept.length)
    if (batch.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }
  return { eligible: kept, ineligibleIds, scanned: fetched }
}

// ─── getAdminScopes(member, user?) ─────────────────────────────────────────
// Returns the admin scopes this member can create events for. Only counts
// `isAdminFor*` edges — being a leader (`leads*`) is not enough to create
// events. Per spec, only Campus/Stream/Council/Governorship/Oversight/
// Denomination admins create events.
//
// If the member-graph result is empty (e.g. test accounts whose JWT carries
// admin roles but whose graph node hasn't been seeded with isAdminFor* edges),
// falls back to scopes encoded in the JWT under `user.churchScopes` —
// the keys are `isAdminFor<Level>Of: { id, name }` (singular Of, not array).
//
// Output: [{ level, id, name }] sorted highest-level first.
export function getAdminScopes(member, user?: any) {
  // Superadmins pick scopes in UI (church search / special groups), not from JWT.
  if (user?.isSuperAdmin) return []
  const scopes = []
  const push = (lvl, list) => {
    for (const x of list || []) {
      if (x?.id) scopes.push({ level: lvl, id: x.id, name: x.name || lvl })
    }
  }
  if (member) {
    push('governorship', member.isAdminForGovernorship)
    push('council',      member.isAdminForCouncil)
    push('stream',       member.isAdminForStream)
    push('campus',       member.isAdminForCampus)
    push('oversight',    member.isAdminForOversight)
    push('denomination', member.isAdminForDenomination)
  }

  // Fallback: when the graph yields nothing, derive scopes from the JWT.
  // Single source of truth lives in utils/userScope.ts.
  if (scopes.length === 0 && user) {
    for (const ref of getUserAdminScopesFromJwt(user)) {
      scopes.push({ level: ref.level, id: ref.id, name: ref.name || ref.level })
    }
  }

  // Dedupe by (level, id) and sort highest-level first.
  const seen = new Set()
  const unique = scopes.filter((s) => {
    const k = `${s.level}:${s.id}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  unique.sort((a, b) => SCOPE_LEVELS.indexOf(b.level as any) - SCOPE_LEVELS.indexOf(a.level as any))
  return unique
}

// ─── getCreatorScopes(member, user?) ───────────────────────────────────────
// Returns church scopes that can be used as anchors for creating events.
// Includes BOTH admin and leader edges from governorship and above so
// higher-scope leaders can create meetings for lower-scope churches.
export function getCreatorScopes(member, user?: any) {
  if (user?.isSuperAdmin) return []
  const scopes: Array<{ level: string; id: string; name: string }> = []
  const push = (lvl: string, list: any[] | undefined) => {
    for (const x of list || []) {
      if (x?.id) scopes.push({ level: lvl, id: x.id, name: x.name || lvl })
    }
  }
  if (member) {
    push('governorship', member.isAdminForGovernorship)
    push('council',      member.isAdminForCouncil)
    push('stream',       member.isAdminForStream)
    push('campus',       member.isAdminForCampus)
    push('oversight',    member.isAdminForOversight)
    push('denomination', member.isAdminForDenomination)
    push('governorship', member.leadsGovernorship)
    push('council',      member.leadsCouncil)
    push('stream',       member.leadsStream)
    push('campus',       member.leadsCampus)
    push('oversight',    member.leadsOversight)
    push('denomination', member.leadsDenomination)
  }

  // Fallback for accounts where graph edges are temporarily unavailable.
  if (scopes.length === 0 && user) {
    for (const ref of getUserAdminScopesFromJwt(user)) {
      scopes.push({ level: ref.level, id: ref.id, name: ref.name || ref.level })
    }
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
    for (const lvl of ['governorship','council','stream','campus','oversight','denomination']) {
      const ref = user?.churchScopes?.[`leads${cap(lvl)}Of`]
      if (ref?.id) scopes.push({ level: lvl, id: ref.id, name: ref.name || lvl })
      const arr = user?.[`leads${cap(lvl)}`]
      if (Array.isArray(arr)) {
        for (const x of arr) if (x?.id) scopes.push({ level: lvl, id: x.id, name: x.name || lvl })
      }
    }
  }

  const seen = new Set<string>()
  const unique = scopes.filter((s) => {
    const k = `${s.level}:${s.id}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  unique.sort((a, b) => SCOPE_LEVELS.indexOf(b.level as any) - SCOPE_LEVELS.indexOf(a.level as any))
  return unique
}

// ─── adminCoversMember(adminScopes, memberRow) ─────────────────────────────
// Returns true if the admin (via any of their adminFor* scopes) has authority
// over the target member, i.e. one of their scope (level, id) pairs matches
// the corresponding *_id column on the member's profile row.
//
// Authority flows DOWNWARD in the hierarchy: a council admin covers every
// member whose council_id matches that council, regardless of their bacenta.
// A campus admin covers anyone whose campus_id matches, etc.
//
// adminScopes:  output of getAdminScopes(member) — [{ level, id, name }]
// memberRow:    a member_profiles row (has bacenta_id, governorship_id, …)
export function adminCoversMember(adminScopes, memberRow): boolean {
  if (!adminScopes?.length || !memberRow) return false
  for (const s of adminScopes) {
    const memberChurchId = memberRow[`${s.level}_id`]
    if (memberChurchId && memberChurchId === s.id) return true
  }
  return false
}

// ─── allowedRolesForScope(scopeLevel) ──────────────────────────────────────
// The role labels that should appear in the "Allowed roles" picker for an
// event at the given scope. Returns, for each level strictly BELOW the scope,
// both the leadership role (leader*) and the admin role (admin*) so that
// admins at sub-levels can also be included in the eligible count and allowed
// to check in.
//
// Examples:
//   'stream'  → ['leaderBacenta','adminBacenta (n/a — no admin edge at bacenta)',
//                'leaderGovernorship','adminGovernorship',
//                'leaderCouncil','adminCouncil']
//   'council' → ['leaderBacenta','leaderGovernorship','adminGovernorship']
export function allowedRolesForScope(scopeLevel) {
  const idx = SCOPE_LEVELS.indexOf(scopeLevel)
  if (idx <= 0) return []
  return SCOPE_LEVELS
    .slice(0, idx)
    .flatMap((lvl) => {
      const cap = lvl[0].toUpperCase() + lvl.slice(1)
      const roles = [`leader${cap}`]
      // adminBacenta doesn't exist in the graph — skip it
      if (lvl !== 'bacenta') roles.push(`admin${cap}`)
      return roles
    })
}

// ─── getChurchAncestors({ level, id }) ──────────────────────────────────────
// Returns the ancestor chain (including the church itself), highest level
// first. Output: [{ level, id, name }, ...].
// For a Bacenta you'd get back: [denomination, oversight, campus, stream,
// council, governorship, bacenta] (whichever exist).
//
// Cached in-memory by `${level}:${id}` for ANCESTORS_TTL — the church
// hierarchy almost never changes within a session.
const ancestorCache = new Map<string, { data: any[]; ts: number }>()
export async function getChurchAncestors({ level, id }) {
  const key = `${level}:${id}`
  const hit = ancestorCache.get(key)
  if (hit && Date.now() - hit.ts < ANCESTORS_TTL) return hit.data

  if (level === 'denomination') {
    const result = [{ level, id, name: 'Denomination' }]
    ancestorCache.set(key, { data: result, ts: Date.now() })
    return result
  }
  const query = ANCESTOR_QUERIES[level]
  if (!query) return [{ level, id, name: '?' }]

  // Pluralized field name (matches the query — bacentas, governorships, etc.)
  const fieldName = level === 'campus' ? 'campuses' : `${level}s`
  let data
  try {
    data = await gqlRequest(query, { id })
  } catch (err) {
    // Graph unreachable — serve whatever chain church_hierarchy has cached
    // from previous sessions (partial chains are still useful; not cached
    // in-memory so a recovered graph wins on the next call).
    const cached = await fetchAncestorScopesFromDb({ level, id }).catch(() => null)
    if (cached?.length) {
      return cached.map((n) => ({ level: n.level, id: n.id, name: n.name || '?' }))
    }
    throw err
  }
  const node = data?.[fieldName]?.[0]
  if (!node) {
    const result = [{ level, id, name: '?' }]
    ancestorCache.set(key, { data: result, ts: Date.now() })
    return result
  }

  const chain = []
  let cur = node
  let curLevel = level
  while (cur) {
    chain.push({ level: curLevel, id: cur.id, name: cur.name })
    // Walk up: the parent property is named after the next level.
    const idx = SCOPE_LEVELS.indexOf(curLevel)
    if (idx === SCOPE_LEVELS.length - 1) break
    const parentLevel = SCOPE_LEVELS[idx + 1]
    cur = cur[parentLevel]
    curLevel = parentLevel
  }
  // Highest first (denomination → bacenta).
  chain.reverse()
  cacheHierarchyChain(chain)  // mirror into church_hierarchy, fire-and-forget
  ancestorCache.set(key, { data: chain, ts: Date.now() })
  return chain
}

// ─── getViewerCapabilities(viewer, event, ancestors, eligibleIds) ──────────
// Computes what the viewer can do for this event.
//
// Inputs:
//   viewer       — the Member node (with leads*/isAdminFor* edges populated)
//   event        — the checkin_events row (needs scope_level, scope_church_id,
//                    allowed_roles)
//   ancestors    — the event scope's ancestor chain from getChurchAncestors
//   eligibleIds  — Set of member ids who are eligible for this event (from
//                    getMembersInScope on the event scope). Used to verify
//                    whether the viewer's leadership target is actually in
//                    the event hierarchy.
//
// Returns:
//   canManage:    viewer is admin of event scope or any ancestor
//   canCheckIn:   viewer is in eligibleIds AND has a role in allowed_roles
//                   AND that role corresponds to a leads* edge strictly below
//                   the event's scope level
//   viewerScope:  the church node we use to filter the dashboard view —
//                   = event scope if viewer canManage (admins see the whole event)
//                   = viewer's narrowest leads* target inside the event scope
//                       if viewer is leader-only
//                   = null if viewer can neither manage nor check in
export function getViewerCapabilities(viewer, event, ancestors, eligibleIds, allMemberIds = null) {
  if (!viewer || !event) {
    return { canManage: false, canCheckIn: false, canView: false, canViewFullEvent: false, canManuallyCheckIn: false, viewerScope: null }
  }
  const eventScopeIdx = SCOPE_LEVELS.indexOf(event.scope_level)

  // canManage — admins of the EXACT event scope church only.
  // Ancestor admins do NOT have manage access to events below their scope;
  // superAdmin bypass is applied by the caller (useEventEligibility).
  const adminEdges = [
    ['governorship', viewer.isAdminForGovernorship],
    ['council',      viewer.isAdminForCouncil],
    ['stream',       viewer.isAdminForStream],
    ['campus',       viewer.isAdminForCampus],
    ['oversight',    viewer.isAdminForOversight],
    ['denomination', viewer.isAdminForDenomination],
  ]
  let canManage = false
  for (const [lvl, list] of adminEdges) {
    if (lvl !== event.scope_level) continue // exact scope level only
    for (const node of list || []) {
      if (node.id === event.scope_church_id) { canManage = true; break }
    }
    if (canManage) break
  }

  // canCheckIn — sub-scope leaders inside the event hierarchy may check THEMSELVES
  // in (self-check-in only). They cannot check in other members manually; that
  // remains admin-only (canManage → ManualCheckInModal).
  // SuperAdmin bypass is applied by the caller (useEventEligibility).
  let canCheckIn = false

  // canView — four cases:
  //   1. Leaders of the EXACT event scope church: read-only view of the whole event.
  //   2. Sub-scope ADMINS (council/governorship/etc.) confirmed in allMemberIds: see
  //      the event scoped to their own admin unit.
  //   3. Sub-scope LEADERS confirmed in allMemberIds: see only their own church slice.
  //   4. Ancestor-scope ADMINS/LEADERS whose church contains the event scope church:
  //      see the full event (it sits entirely within their scope). Validated via the
  //      pre-fetched ancestor chain — no extra round-trip needed.
  let canView = false
  let canViewFullEvent = false
  let subScopeViewerScope = null
  if (!canManage) {
    const leadsEdges = [
      ['bacenta',      viewer.leadsBacenta],
      ['governorship', viewer.leadsGovernorship],
      ['council',      viewer.leadsCouncil],
      ['stream',       viewer.leadsStream],
      ['campus',       viewer.leadsCampus],
      ['oversight',    viewer.leadsOversight],
      ['denomination', viewer.leadsDenomination],
    ]
    const ancestorMap = ancestors?.length
      ? new Map<string, { level: string; id: string; name: string }>(
        ancestors.map((a: any) => [a.level as string, a as { level: string; id: string; name: string }]),
      )
      : null

    // Ancestor-scope admins have read authority over the whole event even when
    // their check-in eligibility comes from a lower leader/admin edge.
    if (ancestorMap) {
      for (const [lvl, list] of adminEdges) {
        if (SCOPE_LEVELS.indexOf(lvl) <= eventScopeIdx) continue // only above event scope
        if (!list?.length) continue
        const a = ancestorMap.get(lvl)
        if (a && (list as any[]).some((n: any) => n.id === a.id)) {
          canView = true
          canViewFullEvent = true
          break
        }
      }
    }
    // Case 1: exact-scope leader
    if (!canView) {
      for (const [lvl, list] of leadsEdges) {
        if (lvl !== event.scope_level) continue
        for (const node of list || []) {
          if (node.id === event.scope_church_id) { canView = true; break }
        }
        if (canView) break
      }
    }
    // Case 2: sub-scope ADMIN (e.g. council/governorship admin) structurally within
    // the event scope. Admin scope takes precedence over leader edges so they land
    // on the dashboard rather than being redirected to self-check-in.
    if (!canView && allMemberIds?.has(viewer.id)) {
      for (const [lvl, list] of adminEdges) {
        if (SCOPE_LEVELS.indexOf(lvl) >= eventScopeIdx) continue // strictly below event scope
        if (!list?.length) continue
        canView = true
        subScopeViewerScope = { level: lvl, id: list[0].id, name: list[0].name }
        break
      }
    }
    // Case 3: sub-scope leader structurally within the event scope.
    // allMemberIds is the full (un-role-filtered) membership set for the event scope.
    // Iterate highest-to-lowest so a leader with multiple roles (e.g. leadsGovernorship
    // AND leadsBacenta) gets the broadest useful view, not the narrowest.
    if (!canView && allMemberIds?.has(viewer.id)) {
      for (const [lvl, list] of [...leadsEdges].reverse()) {
        if (SCOPE_LEVELS.indexOf(lvl) >= eventScopeIdx) continue // strictly below event scope
        if (!list?.length) continue
        canView = true
        subScopeViewerScope = { level: lvl, id: list[0].id, name: list[0].name }
        break
      }
    }
    // Viewers may self-check-in only when one of their roles is actually in
    // allowed_roles (confirmed by eligibleIds). Ancestor-only viewers are not
    // in the eligible set, but dual-role users can keep their lower-scope
    // check-in while seeing the full event through a higher admin role.
    if (canView && eligibleIds?.has(viewer.id)) canCheckIn = true

    // Case 4: ancestor-scope admin or leader.
    // Their church is ABOVE the event scope but structurally contains the event
    // scope church. Validated via the pre-fetched ancestor chain. Picks the most
    // specific (lowest, closest to the event) matching ancestor so they see the
    // tightest possible slice. No canCheckIn — their role isn't in allowed_roles.
    if (!canView && ancestorMap) {
      for (const [lvl, list] of leadsEdges) {
        if (SCOPE_LEVELS.indexOf(lvl) <= eventScopeIdx) continue // only above event scope
        if (!list?.length) continue
        const a = ancestorMap.get(lvl)
        if (a && (list as any[]).some((n: any) => n.id === a.id)) {
          canView = true
          subScopeViewerScope = { level: lvl, id: a.id, name: a.name }
          break
        }
      }
    }
  }

  // viewerScope determines the dashboard slice
  let viewerScope = null
  if (canManage || canViewFullEvent) {
    viewerScope = { level: event.scope_level, id: event.scope_church_id, name: event.scope_church_name }
  } else if (canView) {
    // Sub-scope leader sees only their own slice; exact-scope leader sees the full event scope.
    viewerScope = subScopeViewerScope ?? { level: event.scope_level, id: event.scope_church_id, name: event.scope_church_name }
  }

  // canManuallyCheckIn — admins who can manage the event AND hold NO leader (leads*) edge.
  // If they have any leader role, they check themselves in like a regular leader and
  // cannot manually check in other members.
  const hasLeaderEdge = [
    viewer.leadsBacenta,
    viewer.leadsGovernorship,
    viewer.leadsCouncil,
    viewer.leadsStream,
    viewer.leadsCampus,
    viewer.leadsOversight,
    viewer.leadsDenomination,
  ].some((list) => list?.length > 0)
  const canManuallyCheckIn = canManage && !hasLeaderEdge

  return { canManage, canCheckIn, canView, canViewFullEvent, canManuallyCheckIn, viewerScope }
}

// ─── childScopeLabel(level) ────────────────────────────────────────────────
// Pluralized label for the level immediately below `level` in the FLC
// hierarchy. Used in the dashboard's "Councils: N" stat card.
//   stream → "Councils"   council → "Governorships"
//   bacenta level returns null — bacentas have no children.
export function childScopeLabel(level) {
  const idx = SCOPE_LEVELS.indexOf(level)
  if (idx <= 0) return null
  const child = SCOPE_LEVELS[idx - 1]
  // "Bacenta" + "s" works for every name in the canonical 7.
  return `${child[0].toUpperCase()}${child.slice(1)}s`
}

// Pure version of the child level constant, for picking column names on
// member_profiles rows (e.g. bacenta_id, governorship_id, …).
export function childScopeLevel(level) {
  const idx = SCOPE_LEVELS.indexOf(level)
  if (idx <= 0) return null
  return SCOPE_LEVELS[idx - 1]
}

// ─── countChildScopes({ level, id }) ────────────────────────────────────────
// How many direct children does this scope have? Used by the dashboard's
// "Councils: N" stat card.
export async function countChildScopes({ level, id }: { level: string; id: string }): Promise<number> {
  const query = CHILD_COUNT_QUERIES[level as keyof typeof CHILD_COUNT_QUERIES]
  if (!query) return 0
  const data = await gqlRequest<Record<string, { totalCount: number }>>(query, { id })
  // The response has one *Connection field — grab whatever's there.
  const entry = Object.values(data || {})[0]
  return entry?.totalCount ?? 0
}

// ─── getChildChurches({ level, id }) ─────────────────────────────────────────
// Returns the actual child church nodes { id, name } for a given parent scope.
// Used by ScopeBreakdown to anchor group cards so empty child scopes still
// appear (member-profile grouping misses oversights/campuses with no eligible
// members).
export async function getChildChurches({ level, id }: { level: string; id: string }): Promise<{ id: string; name: string }[]> {
  const query = CHILD_LIST_QUERIES[level as keyof typeof CHILD_LIST_QUERIES]
  if (!query) return []
  const data = await gqlRequest<Record<string, { id: string; name: string }[]>>(query, { id })
  // Response has one array field — grab whatever's there.
  const list = Object.values(data || {})[0]
  const children = Array.isArray(list) ? list : []
  // Mirror the full child list into church_hierarchy and stamp this parent's
  // children_synced_at marker so get_descendant_scopes can trust the subtree.
  cacheHierarchyChildren({ level, id }, childScopeLevel(level), children)
  return children
}

// ─── getChildScopeLeaders({ level, id }) ─────────────────────────────────────
// Authoritative childChurchId → leader mapping for a parent scope, straight
// from the graph's leads* edges. Profile rows only carry generic role strings
// ("leaderBacenta") and can't say WHICH bacenta someone leads, so deriving
// the leader (and their photo) from profiles picks the wrong person.
// Cached + in-flight-deduped like the other graph reads.
export interface ChildScopeLeader {
  id: string
  name: string
  pictureUrl: string | null
}

const childLeadersCache   = new Map<string, { data: Map<string, ChildScopeLeader>; ts: number }>()
const childLeadersPending = new Map<string, Promise<Map<string, ChildScopeLeader>>>()

export async function getChildScopeLeaders(
  { level, id }: { level: string; id: string },
): Promise<Map<string, ChildScopeLeader>> {
  const entry = CHILD_LEADER_QUERIES[level as keyof typeof CHILD_LEADER_QUERIES]
  if (!entry || !id) return new Map()
  const key = `${level}:${id}`
  const hit = childLeadersCache.get(key)
  if (hit && Date.now() - hit.ts < SCOPE_MEMBERS_TTL) return hit.data
  if (childLeadersPending.has(key)) return childLeadersPending.get(key)!

  const p = gqlRequest<{ members: any[] }>(entry.query, { id })
    .then((data) => {
      const map = new Map<string, ChildScopeLeader>()
      for (const m of data?.members || []) {
        if (!isLeaderOrAdmin(m)) continue
        const name = [m.firstName, m.lastName].filter(Boolean).join(' ')
        for (const led of m[entry.ledField] || []) {
          if (led?.id && !map.has(led.id)) {
            map.set(led.id, { id: m.id, name, pictureUrl: m.pictureUrl || null })
          }
        }
      }
      childLeadersCache.set(key, { data: map, ts: Date.now() })
      childLeadersPending.delete(key)
      return map
    })
    .catch((err) => {
      childLeadersPending.delete(key)
      throw err
    })
  childLeadersPending.set(key, p)
  return p
}

// ─── searchChurches(q, limit?) ───────────────────────────────────────────
// Substring-search churches across every level (denomination → governorship).
// Bacentas are intentionally excluded — superadmin event creation targets
// council level and above, and a denomination has ~1700 bacentas which
// would dwarf the result list. If you ever need bacenta search, add a
// separate paged query.
//
// Returns a flat list, level-tagged, deduped by (level, id). Ordered with
// highest scope first so a search for "Test" surfaces "Test Denomination"
// before "Test Council" / "Test Stream" / etc.
const SEARCH_LEVEL_ORDER: Record<string, number> = {
  denomination: 0, oversight: 1, campus: 2, stream: 3, council: 4, governorship: 5,
}

export interface ChurchSearchResult {
  level: 'denomination' | 'oversight' | 'campus' | 'stream' | 'council' | 'governorship'
  id: string
  name: string
}

export async function searchChurches(q: string, limit = 8): Promise<ChurchSearchResult[]> {
  const query = (q || '').trim()
  if (query.length < 2) return []
  const titleCase = query.charAt(0).toUpperCase() + query.slice(1)
  const data = await gqlRequest<Record<string, { id: string; name: string }[]>>(
    SEARCH_CHURCHES, { q: titleCase, qLower: query.toLowerCase(), limit },
  )
  const buckets: Array<[ChurchSearchResult['level'], { id: string; name: string }[] | undefined]> = [
    ['denomination', data?.denominations],
    ['oversight',    data?.oversights],
    ['campus',       data?.campuses],
    ['stream',       data?.streams],
    ['council',      data?.councils],
    ['governorship', data?.governorships],
  ]
  const seen = new Set<string>()
  const out: ChurchSearchResult[] = []
  for (const [level, list] of buckets) {
    for (const row of list || []) {
      if (!row?.id) continue
      const k = `${level}:${row.id}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push({ level, id: row.id, name: row.name })
    }
  }
  out.sort((a, b) => (SEARCH_LEVEL_ORDER[a.level] ?? 9) - (SEARCH_LEVEL_ORDER[b.level] ?? 9))
  return out
}

// ─── isLeaderOrAdmin(member) ────────────────────────────────────────────────
// Returns true iff the member has at least one leads* or isAdminFor* edge.
// Used at login time to gate access — non-leaders bounce back to login.
export function isLeaderOrAdmin(member) {
  if (!member) return false
  return [
    member.leadsBacenta, member.leadsGovernorship, member.leadsCouncil,
    member.leadsStream, member.leadsCampus, member.leadsOversight, member.leadsDenomination,
    member.isAdminForGovernorship, member.isAdminForCouncil, member.isAdminForStream,
    member.isAdminForCampus, member.isAdminForOversight, member.isAdminForDenomination,
  ].some((arr) => Array.isArray(arr) && arr.length > 0)
}

// ─── searchMembersByName ────────────────────────────────────────────────────
// Case-insensitive substring search across firstName and lastName.
//
// Filter-keyed cache (q + limit + lean) so typing "Sam" → "Samuel" doesn't
// re-hit the graph for every intermediate keystroke that lands on a cached
// prefix result after debounce. Lean mode skips hierarchy chains — use it for
// typeaheads; full MEMBER_FIELDS when the caller will memberToProfileRow().

const SEARCH_TTL = 60_000
const searchCache = new Map<string, { data: any[]; ts: number }>()
const searchPending = new Map<string, Promise<any[]>>()

export async function searchMembersByName(
  q: string,
  limit = 10,
  opts?: { lean?: boolean },
): Promise<any[]> {
  const query = (q || '').trim()
  if (query.length < 2) return []
  const lean = opts?.lean !== false // default lean for typeahead safety
  const cacheKey = `${lean ? 'lean' : 'full'}:${limit}:${query.toLowerCase()}`
  const hit = searchCache.get(cacheKey)
  if (hit && Date.now() - hit.ts < SEARCH_TTL) return hit.data
  if (searchPending.has(cacheKey)) return searchPending.get(cacheKey)!

  // Schema only has case-sensitive _CONTAINS/_STARTS_WITH, so pass both the
  // original and a title-cased version to catch "samuel" → "Samuel" mismatches.
  const titleCase = query.charAt(0).toUpperCase() + query.slice(1)
  const document = lean ? SEARCH_MEMBERS_BY_NAME_LEAN : SEARCH_MEMBERS_BY_NAME
  const p = gqlRequest<{ members: any[] }>(document, {
    q: titleCase,
    qLower: query.toLowerCase(),
    limit,
  })
    .then((data) => {
      const result = (data?.members || []).filter(isLeaderOrAdmin)
      searchCache.set(cacheKey, { data: result, ts: Date.now() })
      searchPending.delete(cacheKey)
      return result
    })
    .catch((err) => {
      searchPending.delete(cacheKey)
      throw err
    })
  searchPending.set(cacheKey, p)
  return p
}
