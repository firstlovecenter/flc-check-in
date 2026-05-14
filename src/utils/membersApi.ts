// FLC member directory adapter — wraps VITE_MEMBER_GRAPHQL_URL.
//
// The endpoint is currently open (no auth required for reads). If that
// changes, add the JWT bearer header here in client().
//
// The app's universe is members who lead OR admin something — regular
// members are excluded. See membersApi.queries.js for the OR-filter that
// enforces this in every list query.

import { GraphQLClient } from 'graphql-request'
import { SCOPE_LEVELS } from './auth.js'
import {
  GET_MEMBER_BY_ID,
  GET_MEMBER_BY_EMAIL,
  SCOPE_QUERIES,
  ANCESTOR_QUERIES,
  CHILD_COUNT_QUERIES,
  CHILD_LIST_QUERIES,
} from './membersApi.queries.js'

function graphqlEndpoint() {
  // Always use the same-origin /flc-graphql path.
  // Dev  → Vite proxy (vite.config.js) forwards to the FLC GraphQL endpoint.
  // Prod → Vercel rewrite (vercel.json) forwards it server-side.
  if (typeof window !== 'undefined') return `${window.location.origin}/flc-graphql`
  return '/flc-graphql'
}

// Singleton GraphQL client — avoid creating a new instance on every call.
let _client: GraphQLClient | null = null
function client(): GraphQLClient {
  if (!_client) {
    _client = new GraphQLClient(graphqlEndpoint(), {
      // headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
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
    first_name: m.firstName || null,
    last_name: m.lastName || null,
    phone: m.phoneNumber || m.whatsappNumber || null,
    roles: derivedRoles(m),
    bacenta_id:      bacenta?.id      || null,  bacenta_name:      bacenta?.name      || null,
    governorship_id: governorship?.id || null,  governorship_name: governorship?.name || null,
    council_id:      council?.id      || null,  council_name:      council?.name      || null,
    stream_id:       stream?.id       || null,  stream_name:       stream?.name       || null,
    campus_id:       campus?.id       || null,  campus_name:       campus?.name       || null,
    oversight_id:    oversight?.id    || null,  oversight_name:    oversight?.name    || null,
    denomination_id: denomination?.id || null,  denomination_name: denomination?.name || null,
  }
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

// ─── getAdminScopes(member) ────────────────────────────────────────────────
// Returns the admin scopes this member can create events for. Only counts
// `isAdminFor*` edges — being a leader (`leads*`) is not enough to create
// events. Per spec, only Campus/Stream/Council/Governorship/Oversight/
// Denomination admins create events.
//
// Output: [{ level, id, name }] sorted highest-level first.
export function getAdminScopes(member) {
  if (!member) return []
  const scopes = []
  const push = (lvl, list) => {
    for (const x of list || []) {
      if (x?.id) scopes.push({ level: lvl, id: x.id, name: x.name || lvl })
    }
  }
  push('governorship', member.isAdminForGovernorship)
  push('council',      member.isAdminForCouncil)
  push('stream',       member.isAdminForStream)
  push('campus',       member.isAdminForCampus)
  push('oversight',    member.isAdminForOversight)
  push('denomination', member.isAdminForDenomination)

  // Dedupe by (level, id) and sort highest-level first.
  const seen = new Set()
  const unique = scopes.filter((s) => {
    const k = `${s.level}:${s.id}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  unique.sort((a, b) => SCOPE_LEVELS.indexOf(b.level) - SCOPE_LEVELS.indexOf(a.level))
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
  const data = await client().request(query, { id })
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
    return { canManage: false, canCheckIn: false, canView: false, canManuallyCheckIn: false, viewerScope: null }
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

  // canView — two cases:
  //   1. Leaders of the EXACT event scope church: read-only view of the whole event.
  //   2. Sub-scope leaders whose church is WITHIN the event scope (confirmed by
  //      allMemberIds — the un-role-filtered set from getMembersInScope). They
  //      see the event but only per their own church scope.
  // Leaders at ancestor/parent scopes are still blocked.
  let canView = false
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
    // Case 1: exact-scope leader
    for (const [lvl, list] of leadsEdges) {
      if (lvl !== event.scope_level) continue
      for (const node of list || []) {
        if (node.id === event.scope_church_id) { canView = true; break }
      }
      if (canView) break
    }
    // Case 2: sub-scope leader structurally within the event scope.
    // allMemberIds is the full (un-role-filtered) membership set for the event scope.
    if (!canView && allMemberIds?.has(viewer.id)) {
      for (const [lvl, list] of leadsEdges) {
        if (SCOPE_LEVELS.indexOf(lvl) >= eventScopeIdx) continue // strictly below event scope
        if (!list?.length) continue
        canView = true
        subScopeViewerScope = { level: lvl, id: list[0].id, name: list[0].name }
        break
      }
    }
    // Sub-scope leaders in scope may self-check-in (but not check in others manually).
    if (canView && subScopeViewerScope) canCheckIn = true
  }

  // viewerScope determines the dashboard slice
  let viewerScope = null
  if (canManage) {
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

  return { canManage, canCheckIn, canView, canManuallyCheckIn, viewerScope }
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
  return Array.isArray(list) ? list : []
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
