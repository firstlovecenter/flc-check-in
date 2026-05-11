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
  // Dev → use the Vite proxy at /flc-graphql to dodge the missing CORS
  // headers on the FLC dev API. graphql-request requires an absolute URL, so
  // we build one against the current page origin.
  // Prod → use the configured URL directly (configure an equivalent rewrite
  // on the host if needed).
  if (import.meta.env.DEV) {
    if (typeof window !== 'undefined') return `${window.location.origin}/flc-graphql`
    return '/flc-graphql'
  }
  const url = import.meta.env.VITE_MEMBER_GRAPHQL_URL
  if (!url) throw new Error('VITE_MEMBER_GRAPHQL_URL is not configured')
  return url
}

function client() {
  // Bearer header is optional today — uncomment if the endpoint starts
  // requiring it.
  // const token = localStorage.getItem('accessToken')
  return new GraphQLClient(graphqlEndpoint(), {
    // headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
}

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
// Best-effort lookup of the logged-in user in the FLC member graph. The auth
// API and the member graph may use different ID systems, so we try id first
// then fall back to email.
//
// Cached per-session so we don't re-query the graph on every screen.
// Only positive hits are cached — null results retry on the next call so a
// transient network failure doesn't poison the session.
const memberByUserCache = new Map()
export async function resolveCurrentMember(user) {
  if (!user) return null
  const cacheKey = user.userId || user.email
  if (cacheKey && memberByUserCache.has(cacheKey)) return memberByUserCache.get(cacheKey)
  let member = null
  if (user.userId) {
    try {
      member = await getMemberById(user.userId)
    } catch (err: any) {
      console.warn('[resolveCurrentMember] getMemberById failed:', err.message)
    }
  }
  if (!member && user.email) {
    try {
      member = await getMemberByEmail(user.email)
    } catch (err: any) {
      console.warn('[resolveCurrentMember] getMemberByEmail failed:', err.message)
    }
  }
  if (cacheKey && member) memberByUserCache.set(cacheKey, member)
  return member
}

// ─── getMembersInScope({ level, churchId }) ─────────────────────────────────
// Returns every leader/admin within the given scope's hierarchy, including
// the scope itself.
export async function getMembersInScope({ level, churchId }) {
  if (!SCOPE_LEVELS.includes(level)) {
    throw new Error(`Unknown scope level: ${level}`)
  }
  const query = SCOPE_QUERIES[level]
  if (!query) throw new Error(`No scope query for level: ${level}`)
  const data = await client().request(query, { churchId })
  return data?.members || []
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
// Cached in-memory by `${level}:${id}` since hierarchy doesn't change often.
const ancestorCache = new Map()
export async function getChurchAncestors({ level, id }) {
  const key = `${level}:${id}`
  if (ancestorCache.has(key)) return ancestorCache.get(key)

  if (level === 'denomination') {
    const result = [{ level, id, name: 'Denomination' }]
    ancestorCache.set(key, result)
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
    ancestorCache.set(key, result)
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
  ancestorCache.set(key, chain)
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
export function getViewerCapabilities(viewer, event, ancestors, eligibleIds) {
  if (!viewer || !event) {
    return { canManage: false, canCheckIn: false, viewerScope: null }
  }
  const ancestorKeys = new Set(ancestors.map((a) => `${a.level}:${a.id}`))
  const eventScopeIdx = SCOPE_LEVELS.indexOf(event.scope_level)

  // canManage — admins of the event scope or any ancestor
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
    for (const node of list || []) {
      if (ancestorKeys.has(`${lvl}:${node.id}`)) { canManage = true; break }
    }
    if (canManage) break
  }

  // canCheckIn — viewer must:
  //   (1) have a leads* edge whose role is in event.allowed_roles
  //   (2) have that leads* level be strictly below the event scope
  //   (3) appear in the eligible-id set (the authoritative scope-membership check)
  const allowedRoles = new Set(event.allowed_roles || [])
  const leadEdges = [
    ['bacenta',      viewer.leadsBacenta,      'leaderBacenta'],
    ['governorship', viewer.leadsGovernorship, 'leaderGovernorship'],
    ['council',      viewer.leadsCouncil,      'leaderCouncil'],
    ['stream',       viewer.leadsStream,       'leaderStream'],
    ['campus',       viewer.leadsCampus,       'leaderCampus'],
    ['oversight',    viewer.leadsOversight,    'leaderOversight'],
    ['denomination', viewer.leadsDenomination, 'leaderDenomination'],
  ]

  let canCheckIn = false
  let leaderViewerScope = null
  if (eligibleIds && eligibleIds.has(viewer.id)) {
    // Check leads* edges (standard leaders)
    for (const [lvl, list, roleStr] of leadEdges) {
      if (!list?.length) continue
      if (!allowedRoles.has(roleStr)) continue
      if (SCOPE_LEVELS.indexOf(lvl) >= eventScopeIdx) continue // strictly below
      canCheckIn = true
      leaderViewerScope = { level: lvl, id: list[0].id, name: list[0].name }
      break
    }
    // Also check isAdminFor* edges — admins at a level strictly below the
    // event scope can check in when their admin role is in allowed_roles.
    if (!canCheckIn) {
      const adminCheckEdges = [
        ['governorship', viewer.isAdminForGovernorship, 'adminGovernorship'],
        ['council',      viewer.isAdminForCouncil,      'adminCouncil'],
        ['stream',       viewer.isAdminForStream,       'adminStream'],
        ['campus',       viewer.isAdminForCampus,       'adminCampus'],
        ['oversight',    viewer.isAdminForOversight,    'adminOversight'],
        ['denomination', viewer.isAdminForDenomination, 'adminDenomination'],
      ]
      for (const [lvl, list, roleStr] of adminCheckEdges) {
        if (!list?.length) continue
        if (!allowedRoles.has(roleStr)) continue
        if (SCOPE_LEVELS.indexOf(lvl) >= eventScopeIdx) continue // strictly below
        canCheckIn = true
        leaderViewerScope = { level: lvl, id: list[0].id, name: list[0].name }
        break
      }
    }
  }

  // viewerScope determines the dashboard slice
  let viewerScope = null
  if (canManage) {
    viewerScope = { level: event.scope_level, id: event.scope_church_id, name: event.scope_church_name }
  } else if (leaderViewerScope) {
    viewerScope = leaderViewerScope
  }

  return { canManage, canCheckIn, viewerScope }
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
