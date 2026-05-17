// User scope resolution — the SINGLE source of truth for the question:
//   "Which churches does the logged-in user have a structural relationship
//    with, and at what level, and via which source?"
//
// Why this exists
// ---------------
// The FLC user object is assembled from three asynchronous sources, none of
// which is guaranteed to be complete:
//
//   1. JWT top-level refs (user.bacenta / user.council / .../user.denomination)
//      — only populated for some account types; e.g. a `leaderCouncil` test
//      account's JWT only carries `churchScopes.leadsCouncilOf` and nothing at
//      the top level.
//
//   2. localStorage churchContext, hydrated from member_profiles after first
//      login or refresh. Often the full ancestor chain.
//
//   3. JWT `churchScopes` block — `isAdminFor<Level>Of` and `leads<Level>Of`
//      single-edge references. Always present for admin/leader accounts.
//
// Coexisting admin + leader edges
// -------------------------------
// A user can BOTH lead one church AND admin a different church at the same
// level (e.g. streamadmin@test.com leads "ToClose 2" while admining "Test
// Stream"). Policy: users see events for ALL their churches at every level,
// and capability on a given event is decided by which edge matched.
//
// `getUserChurchRefs(user)` returns every (level, churchId) the user is
// structurally tied to, tagged with the source that produced it. Callers
// building visibility filters consume the full list; callers asking "do I
// admin this event?" check the matched ref's `source` field.

import { SCOPE_LEVELS, type ScopeLevel, type AppUser } from '../types/app'

/** Provenance of a scope reference — lets capability code distinguish
 *  "this user admins church X" from "this user leads church Y". */
export type UserScopeSource = 'flat' | 'active' | 'admin' | 'leader'

/** A single church reference, normalised across all JWT/profile shapes. */
export interface UserScopeRef {
  level: ScopeLevel
  id: string
  /** Display name; may be missing if the source only carried an id. */
  name?: string
  /** Where this ref was resolved from — see UserScopeSource. */
  source: UserScopeSource
}

/** Capitalise the first letter — safe for ASCII level names. */
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** All refs the user has at a single level, deduped by id.
 *  When the user holds both an admin edge and a leader edge at the same
 *  level (different church IDs), both are returned — the user can see
 *  events for either church, and capability is decided per-event.
 *
 *  Order within a level: flat → activeChurch → admin → leader. The first
 *  match for any given id wins (so a flat ref shadowing an admin ref keeps
 *  the `source: 'flat'` tag — flat refs are usually the user's "primary"
 *  scope). */
export function getUserChurchRefsAt(user: AppUser | null | undefined, level: ScopeLevel): UserScopeRef[] {
  if (!user) return []
  const out: UserScopeRef[] = []
  const seen = new Set<string>()
  const push = (id: string | undefined, name: string | undefined, source: UserScopeSource) => {
    if (typeof id !== 'string' || !id) return
    if (seen.has(id)) return
    seen.add(id)
    out.push({ level, id, name, source })
  }

  // 1. Flat top-level ref (JWT-embedded or hydrated from member_profiles).
  const flat = (user as any)[level]
  if (flat && typeof flat === 'object') {
    push(flat.id, typeof flat.name === 'string' ? flat.name : undefined, 'flat')
  }

  // 2. The user's "active church" if its level matches.
  const active = user.activeChurch
  if (active && active.level === level) {
    push(active.id, typeof active.name === 'string' ? active.name : undefined, 'active')
  }

  // 3. JWT admin edge.
  const cs = user.churchScopes
  if (cs) {
    const adminRef = (cs as Record<string, { id: string; name?: string } | null | undefined>)[`isAdminFor${cap(level)}Of`]
    if (adminRef) push(adminRef.id, adminRef.name, 'admin')

    // 4. JWT leader edge — kept alongside the admin edge if it's a different id.
    const leadsRef = (cs as Record<string, { id: string; name?: string } | null | undefined>)[`leads${cap(level)}Of`]
    if (leadsRef) push(leadsRef.id, leadsRef.name, 'leader')
  }

  return out
}

/** Look up the user's CANONICAL (single preferred) church reference at one
 *  level. Resolution order:
 *    1. user[lvl]?.id                          — top-level/hydrated
 *    2. activeChurch when level matches
 *    3. churchScopes.isAdminFor<L>Of           — admin edge
 *    4. churchScopes.leads<L>Of                — leader edge
 *
 *  Use this when you need ONE answer (e.g. "what scope should the dashboard
 *  centre on?"). Use getUserChurchRefsAt(...) instead when you want the full
 *  set of churches the user has any relationship with at that level. */
export function getUserChurchRef(user: AppUser | null | undefined, level: ScopeLevel): UserScopeRef | null {
  return getUserChurchRefsAt(user, level)[0] ?? null
}

/** Convenience: just the canonical id at a level, or null. */
export function getUserChurchId(user: AppUser | null | undefined, level: ScopeLevel): string | null {
  return getUserChurchRef(user, level)?.id ?? null
}

/** Every church ref the user has across every level, deduped by (level, id).
 *  Used to build event-visibility filters: each (level, churchId) pair
 *  contributes one PostgREST OR clause. Refs are returned in SCOPE_LEVELS
 *  order (lowest → highest); within a level, see getUserChurchRefsAt for
 *  the internal order. */
export function getUserChurchRefs(user: AppUser | null | undefined): UserScopeRef[] {
  if (!user) return []
  const out: UserScopeRef[] = []
  for (const level of SCOPE_LEVELS) {
    out.push(...getUserChurchRefsAt(user, level))
  }
  return out
}

/** Returns true if the user holds an `isAdminFor<L>Of` edge for the given
 *  level, either in the JWT or via the graph-hydrated profile. Use this
 *  instead of checking role-string prefixes — it's resilient to role renames. */
export function isUserAdminAt(user: AppUser | null | undefined, level: ScopeLevel): boolean {
  if (!user) return false
  if (user.isSuperAdmin) return true
  const cs = user.churchScopes
  if (!cs) return false
  const adminRef = (cs as Record<string, { id: string } | null | undefined>)[`isAdminFor${cap(level)}Of`]
  return !!(adminRef && adminRef.id)
}

/** Admin-only scope levels. Bacenta has no admin edge in the FLC graph —
 *  bacenta leaders cannot create events; only governorship and above can. */
const ADMIN_SCOPE_LEVELS: ScopeLevel[] = [
  'governorship', 'council', 'stream', 'campus', 'oversight', 'denomination',
]

/** Admin scopes resolved purely from the JWT's `churchScopes.isAdminFor<L>Of`
 *  edges. Used as a fallback when the FLC graph is unreachable and the graph
 *  node's `isAdminFor*` arrays are unavailable. Returned highest-level first
 *  to match the sort order graph-derived admin scopes use. */
export function getUserAdminScopesFromJwt(user: AppUser | null | undefined): UserScopeRef[] {
  if (!user?.churchScopes) return []
  const cs = user.churchScopes
  const out: UserScopeRef[] = []
  for (const level of ADMIN_SCOPE_LEVELS) {
    const ref = (cs as Record<string, { id: string; name?: string } | null | undefined>)[`isAdminFor${cap(level)}Of`]
    if (ref && typeof ref.id === 'string') {
      out.push({ level, id: ref.id, name: ref.name, source: 'admin' })
    }
  }
  // Sort highest level first — denomination → governorship.
  return out.sort((a, b) => ADMIN_SCOPE_LEVELS.indexOf(b.level) - ADMIN_SCOPE_LEVELS.indexOf(a.level))
}
