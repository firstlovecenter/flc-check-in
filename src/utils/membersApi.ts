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
  SCOPE_QUERIES,
  ANCESTOR_QUERIES,
  CHILD_COUNT_QUERIES,
  CHILD_LIST_QUERIES,
  GET_ALL_MEMBERS_PAGE,
  SEARCH_CHURCHES,
  SEARCH_MEMBERS_BY_NAME,
} from './membersApi.queries.js'

function graphqlEndpoint() {
  // Always use the same-origin /flc-graphql path.
  // Dev  → Vite proxy (vite.config.js) forwards to the FLC GraphQL endpoint.
  // Prod → Vercel rewrite (vercel.json) forwards it server-side.
  if (typeof window !== 'undefined') return `${window.location.origin}/flc-graphql`
  return '/flc-graphql'
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
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    _clientToken = token
  }
  return _client
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

// ─── Convert a Member node into the shape we cache in member_profiles ──────
// Picks the church the member LEADS or ADMINS at each level, falling back to
// their personal assignment only if they hold no leadership at that level.
//
// Why this matters: a leader's `Member.bacenta` is where they personally
// attend, which may differ from the bacenta they LEAD. E.g. Kofi attends
// Bacenta A (Stream A) but leads Bacenta B (Stream B). Our event eligibility
// filter places him under Stream B (because that's where his leadership
// edge points). The row we cache should agree — bacenta_name = Bacenta B,
// stream_name = Stream B — otherwise the dashboard shows the wrong unit.
export function memberToProfileRow(m) {
  const pickFirst = (arr) => (Array.isArray(arr) && arr[0]) || null
  // Leadership-target wins at each level.
  // Crucially: a bacenta leader only has a direct leadership edge at the
  // bacenta level — their governorship/council/stream IDs must be derived by
  // walking up the parent chain embedded in the leadsBacenta object.
  // The MEMBER_FIELDS fragment now includes those nested parents.
  const leadsBackenta = pickFirst(m.leadsBacenta)
  const bacenta       = leadsBackenta || m.bacenta
  // Walk up: leadsGovernorship → isAdminForGovernorship → bacenta.governorship
  const governorship  = pickFirst(m.leadsGovernorship) || pickFirst(m.isAdminForGovernorship)
                        || (leadsBackenta as any)?.governorship || null
  // Walk up: leadsCouncil → isAdminForCouncil → governorship.council
  const council       = pickFirst(m.leadsCouncil) || pickFirst(m.isAdminForCouncil)
                        || (governorship as any)?.council || null
  // Walk up: leadsStream → isAdminForStream → council.stream
  const stream        = pickFirst(m.leadsStream) || pickFirst(m.isAdminForStream)
                        || (council as any)?.stream || null
  // Walk up: leadsCampus → isAdminForCampus → stream.campus
  const campus        = pickFirst(m.leadsCampus) || pickFirst(m.isAdminForCampus)
                        || (stream as any)?.campus || null
  // Walk up: leadsOversight → isAdminForOversight → campus.oversight
  const oversight     = pickFirst(m.leadsOversight) || pickFirst(m.isAdminForOversight)
                        || (campus as any)?.oversight || null
  // Walk up: leadsDenomination → isAdminForDenomination → oversight.denomination
  const denomination  = pickFirst(m.leadsDenomination) || pickFirst(m.isAdminForDenomination)
                        || (oversight as any)?.denomination || null

  return {
    id: m.id,
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
    scope_ids: extractAllScopeIds(m),
  }
}

// Walks every leads* and isAdminFor* edge on a graph Member node and collects
// ALL scope IDs at each hierarchy level. The MEMBER_FIELDS fragment embeds
// each node's full parent chain, so a single pass per edge type is enough.
// Result shape: { campus: ["id1","id2"], stream: ["id1"], … }
// Only levels with at least one ID are included.
function extractAllScopeIds(m: any): Record<string, string[]> {
  const acc: Record<string, Set<string>> = {}
  const add = (level: string, node: any) => {
    if (!node?.id) return
    ;(acc[level] ??= new Set()).add(node.id)
  }
  // Walk from `node` at `startLevel` up through embedded parent fields.
  // The MEMBER_FIELDS fragment nests parents using their level name as the
  // field key (bacenta → bacenta.governorship → …governorship.council → etc.)
  const walkUp = (node: any, startLevel: string) => {
    if (!node) return
    let cur: any = node
    let idx = (SCOPE_LEVELS as readonly string[]).indexOf(startLevel)
    while (idx >= 0 && idx < SCOPE_LEVELS.length) {
      const level = SCOPE_LEVELS[idx]
      if (level === 'special_group') break
      add(level, cur)
      idx++
      if (idx >= SCOPE_LEVELS.length || SCOPE_LEVELS[idx] === 'special_group') break
      cur = cur[SCOPE_LEVELS[idx]] ?? null
      if (!cur) break
    }
  }
  for (const b   of m.leadsBacenta            || []) walkUp(b,   'bacenta')
  for (const g   of m.leadsGovernorship        || []) walkUp(g,   'governorship')
  for (const g   of m.isAdminForGovernorship   || []) walkUp(g,   'governorship')
  for (const c   of m.leadsCouncil             || []) walkUp(c,   'council')
  for (const c   of m.isAdminForCouncil        || []) walkUp(c,   'council')
  for (const s   of m.leadsStream              || []) walkUp(s,   'stream')
  for (const s   of m.isAdminForStream         || []) walkUp(s,   'stream')
  for (const cam of m.leadsCampus              || []) walkUp(cam, 'campus')
  for (const cam of m.isAdminForCampus         || []) walkUp(cam, 'campus')
  for (const o   of m.leadsOversight           || []) walkUp(o,   'oversight')
  for (const o   of m.isAdminForOversight      || []) walkUp(o,   'oversight')
  for (const d   of m.leadsDenomination        || []) add('denomination', d)
  for (const d   of m.isAdminForDenomination   || []) add('denomination', d)
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
  const data = await client().request(GET_MEMBER_BY_ID, { id })
  return data?.members?.[0] || null
}

// ─── getMemberByEmail ──────────────────────────────────────────────────────
export async function getMemberByEmail(email) {
  const data = await client().request(GET_MEMBER_BY_EMAIL, { email })
  return data?.members?.[0] || null
}

// ─── resolveCurrentMember(user) ────────────────────────────────────────────
// Best-effort lookup of the logged-in user in the FLC member graph. ID and
// email lookups run IN PARALLEL so auth-system IDs that don't match graph IDs
// don't add a second serial round-trip.
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
    // Run ID and email lookups in parallel — saves ~500ms when the auth-system
    // userId doesn't exist in the graph (each query is ~400-600ms independently).
    const [byId, byEmail] = await Promise.allSettled([
      user.userId ? getMemberById(user.userId) : Promise.resolve(null),
      user.email  ? getMemberByEmail(user.email) : Promise.resolve(null),
    ])
    return (byId.status === 'fulfilled' ? byId.value : null)
        || (byEmail.status === 'fulfilled' ? byEmail.value : null)
        || null
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

  const p = client().request(query, { churchId })
    .then((data: any) => {
      const result: any[] = data?.members || []
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
  opts?: { includeAllMembers?: boolean },
): Promise<any[]> {
  const PAGE_SIZE = 500
  const kept: any[] = []
  let offset = 0
  let fetched = 0
  const includeAll = !!opts?.includeAllMembers
  // Hard cap to avoid runaway loops if the server ignores offset.
  const MAX_PAGES = 200
  for (let page = 0; page < MAX_PAGES; page++) {
    const data: any = await client().request(GET_ALL_MEMBERS_PAGE, {
      limit: PAGE_SIZE, offset,
    })
    const batch: any[] = data?.members || []
    fetched += batch.length
    for (const m of batch) {
      if (includeAll || isLeaderOrAdmin(m)) kept.push(m)
    }
    onProgress?.(fetched, kept.length)
    if (batch.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }
  return kept
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
    data = await client().request(query, { id })
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
  const data = await client().request<Record<string, { totalCount: number }>>(query, { id })
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
  const data = await client().request<Record<string, { id: string; name: string }[]>>(query, { id })
  // Response has one array field — grab whatever's there.
  const list = Object.values(data || {})[0]
  const children = Array.isArray(list) ? list : []
  // Mirror the full child list into church_hierarchy and stamp this parent's
  // children_synced_at marker so get_descendant_scopes can trust the subtree.
  cacheHierarchyChildren({ level, id }, childScopeLevel(level), children)
  return children
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
  const data = await client().request<Record<string, { id: string; name: string }[]>>(
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
// Returns full MemberFields so callers can pass results to memberToProfileRow().
export async function searchMembersByName(q: string, limit = 10): Promise<any[]> {
  const query = (q || '').trim()
  if (query.length < 2) return []
  // Schema only has case-sensitive _CONTAINS/_STARTS_WITH, so pass both the
  // original and a title-cased version to catch "samuel" → "Samuel" mismatches.
  const titleCase = query.charAt(0).toUpperCase() + query.slice(1)
  const data = await client().request<{ members: any[] }>(
    SEARCH_MEMBERS_BY_NAME,
    { q: titleCase, qLower: query.toLowerCase(), limit },
  )
  return data?.members || []
}
