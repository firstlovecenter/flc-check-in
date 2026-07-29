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
 *  Order within a level: leader → admin → activeChurch → flat. The first
 *  match for any given id wins, and callers that want ONE answer take [0].
 *
 *  Why role edges come first
 *  -------------------------
 *  The flat ref is read from the localStorage `churchContext`, which is a
 *  CACHE of member_profiles' flat columns. Those columns describe only the
 *  member's primary chain, and historically could describe a chain spliced
 *  from two different hierarchies (see buildScopeChains in membersApi.ts).
 *  Ranking that cache above the actual `leads<L>Of` / `isAdminFor<L>Of` edges
 *  meant capability checks consulted a stale — sometimes fabricated —
 *  hierarchy in preference to the authoritative one.
 *
 *  Role edges come from the JWT and the graph. They are the truth. The flat
 *  ref stays as a last resort for accounts whose JWT carries no role edges. */
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

  const cs = user.churchScopes as Record<string, { id: string; name?: string } | null | undefined> | undefined

  // 1. JWT leader edge — the strongest signal for "where does this user belong".
  if (cs) {
    const leadsRef = cs[`leads${cap(level)}Of`]
    if (leadsRef) push(leadsRef.id, leadsRef.name, 'leader')
  }

  // 2. Top-level leader array — the auth lambda populates leads<Level>
  //    (no "Of") as a full array when the user holds several edges at one level.
  const leadsArr = (user as any)[`leads${cap(level)}`]
  if (Array.isArray(leadsArr)) {
    for (const ref of leadsArr) {
      if (ref?.id) push(ref.id, ref.name, 'leader')
    }
  }

  // 3. JWT admin edge.
  if (cs) {
    const adminRef = cs[`isAdminFor${cap(level)}Of`]
    if (adminRef) push(adminRef.id, adminRef.name, 'admin')
  }

  // 4. Top-level admin array (e.g. adminCampus for Ashesi AND Central University).
  const adminArr = (user as any)[`isAdminFor${cap(level)}`]
  if (Array.isArray(adminArr)) {
    for (const ref of adminArr) {
      if (ref?.id) push(ref.id, ref.name, 'admin')
    }
  }

  // 5. The user's "active church" if its level matches.
  const active = user.activeChurch
  if (active && active.level === level) {
    push(active.id, typeof active.name === 'string' ? active.name : undefined, 'active')
  }

  // 6. Flat top-level ref (JWT-embedded or hydrated from member_profiles).
  //    Last: it is a cache of the primary chain, not an authoritative edge.
  const flat = (user as any)[level]
  if (flat && typeof flat === 'object') {
    push(flat.id, typeof flat.name === 'string' ? flat.name : undefined, 'flat')
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

/** Church levels that can carry admin/leader edges (everything but special_group). */
const ROLE_EDGE_LEVELS: ScopeLevel[] = [
  'bacenta', 'governorship', 'council', 'stream', 'campus', 'oversight', 'denomination',
]

/** Every church the user holds an actual ROLE edge for — `isAdminFor<L>Of` /
 *  `leads<L>Of` single-edge refs plus the top-level `isAdminFor<Level>` /
 *  `leads<Level>` arrays. Flat profile refs (where the user merely sits as a
 *  member) are deliberately NOT consulted: event visibility is based on where
 *  the user leads/admins, never on where they are a member.
 *
 *  Reads the edges directly rather than filtering getUserChurchRefs() by
 *  source — there, a flat ref with the same church id shadows the role edge
 *  (first push wins, tagged 'flat'), which would wrongly drop the church for
 *  the common case of a leader who is also a member of the church they lead.
 *
 *  Returned in SCOPE_LEVELS order (lowest → highest), deduped by (level, id);
 *  when both an admin and a leader edge exist for the same church, the admin
 *  tag wins (matters to capability checks, not visibility). */
export function getUserLeadershipRefs(user: AppUser | null | undefined): UserScopeRef[] {
  if (!user) return []
  const seen = new Set<string>()
  const out: UserScopeRef[] = []
  const push = (level: ScopeLevel, id: string | undefined, name: string | undefined, source: UserScopeSource) => {
    if (typeof id !== 'string' || !id) return
    const key = `${level}:${id}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ level, id, name, source })
  }

  for (const level of ROLE_EDGE_LEVELS) {
    const cs = user.churchScopes as Record<string, { id: string; name?: string } | null | undefined> | undefined
    if (cs) {
      const adminRef = cs[`isAdminFor${cap(level)}Of`]
      if (adminRef?.id) push(level, adminRef.id, adminRef.name, 'admin')
      const leadsRef = cs[`leads${cap(level)}Of`]
      if (leadsRef?.id) push(level, leadsRef.id, leadsRef.name, 'leader')
    }
    const adminArr = (user as any)[`isAdminFor${cap(level)}`]
    if (Array.isArray(adminArr)) {
      for (const ref of adminArr) if (ref?.id) push(level, ref.id, ref.name, 'admin')
    }
    const leadsArr = (user as any)[`leads${cap(level)}`]
    if (Array.isArray(leadsArr)) {
      for (const ref of leadsArr) if (ref?.id) push(level, ref.id, ref.name, 'leader')
    }
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
  if (cs) {
    const adminRef = (cs as Record<string, { id: string } | null | undefined>)[`isAdminFor${cap(level)}Of`]
    if (adminRef?.id) return true
  }
  // Also check the top-level array (multi-scope users have isAdminFor<Level> arrays).
  const adminArr = (user as any)[`isAdminFor${cap(level)}`]
  return Array.isArray(adminArr) && adminArr.some((r: any) => r?.id)
}

/** Admin-only scope levels. Bacenta has no admin edge in the FLC graph —
 *  bacenta leaders cannot create events; only governorship and above can. */
const ADMIN_SCOPE_LEVELS: ScopeLevel[] = [
  'governorship', 'council', 'stream', 'campus', 'oversight', 'denomination',
]

/** Admin scopes resolved from the JWT — checks both the `churchScopes`
 *  single-edge block and the top-level `isAdminFor<Level>` arrays (for users
 *  with multiple admin edges at the same level). Used as a fallback when the
 *  FLC graph is unreachable. Returned highest-level first. */
export function getUserAdminScopesFromJwt(user: AppUser | null | undefined): UserScopeRef[] {
  if (!user) return []
  const seen = new Set<string>()
  const out: UserScopeRef[] = []
  const push = (level: ScopeLevel, id: string, name?: string) => {
    const key = `${level}:${id}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ level, id, name, source: 'admin' })
  }

  for (const level of ADMIN_SCOPE_LEVELS) {
    // churchScopes single-edge ref.
    const cs = user.churchScopes
    if (cs) {
      const ref = (cs as Record<string, { id: string; name?: string } | null | undefined>)[`isAdminFor${cap(level)}Of`]
      if (ref?.id) push(level, ref.id, ref.name)
    }
    // Top-level array (multi-scope users).
    const arr = (user as any)[`isAdminFor${cap(level)}`]
    if (Array.isArray(arr)) {
      for (const ref of arr) {
        if (ref?.id) push(level, ref.id, ref.name)
      }
    }
  }

  return out.sort((a, b) => ADMIN_SCOPE_LEVELS.indexOf(b.level) - ADMIN_SCOPE_LEVELS.indexOf(a.level))
}
