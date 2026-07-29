// Role scopes — "which hat is the user wearing right now?"
//
// Why this exists
// ---------------
// The app used to focus on a CHURCH: `{ level, id, name }`. That cannot
// describe a user who is both the Leader and the Admin of the same
// governorship (the two collapsed into one indistinguishable chip), and it
// cannot say which of a multi-role user's identities an action is being taken
// under. Capability was then derived separately, from the MAXIMUM of every
// role the user held anywhere — so a Bacenta leader who also held any stream
// admin edge was permanently routed to a dashboard for events they were
// supposed to personally attend.
//
// The FL Admin Portal solved this years ago and we mirror it here: the unit of
// identity is the (role, church) PAIR, keyed `${source}:${level}:${id}`, one
// option per edge, and exactly one is active at a time. See
// web-react-ts/src/contexts/ChurchRoleScopeContext.tsx in that repo.
//
// Two rules carried over from the portal, both load-bearing:
//   1. Options are labelled by role AND church ("Governorship Leader ·
//      Emmanuel"), never church alone.
//   2. The default is the user's LOWEST (most specific) role, not a union of
//      everything. A union cannot answer "what may I do here?".

import { SCOPE_LEVELS, type ScopeLevel, type AppUser } from '../types/app'

/** Hineni's operational universe is deliberately leaders and admins only.
 *
 *  Specialist roles (arrivalsAdmin*, arrivalsCounter*, teller*, fishers) carry
 *  real church edges in the graph but are NOT modelled here: they belong to the
 *  portal's arrivals and banking flows, not to attendance. A member who holds
 *  only a specialist role therefore gets no hat and no event visibility from
 *  it — that is the intended product boundary, not an oversight. */
export type RoleScopeSource = 'leader' | 'admin'

export interface RoleScope {
  /** Stable identity of this hat. Persisted, and used for equality. */
  key: string
  source: RoleScopeSource
  level: ScopeLevel
  id: string
  /** Church name; falls back to the capitalised level when the edge carried none. */
  name: string
  /** "Governorship Leader" — role without the church. */
  roleLabel: string
  /** "Governorship Leader · Emmanuel" — what the switcher shows. */
  displayName: string
}

/** Church levels that can carry role edges, lowest → highest.
 *  special_group sits outside the church tree and has no leader/admin edges. */
const ROLE_EDGE_LEVELS: ScopeLevel[] = [
  'bacenta', 'governorship', 'council', 'stream', 'campus', 'oversight', 'denomination',
]

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function roleScopeKey(source: RoleScopeSource, level: string, id: string): string {
  return `${source}:${level}:${id}`
}

const SOURCE_LABEL: Record<RoleScopeSource, string> = {
  leader: 'Leader',
  admin: 'Admin',
}

function buildLabels(source: RoleScopeSource, level: ScopeLevel, name: string) {
  const roleLabel = `${cap(level)} ${SOURCE_LABEL[source]}`
  return { roleLabel, displayName: name ? `${roleLabel} · ${name}` : roleLabel }
}

/**
 * Every (role, church) pair the user holds, most-specific first.
 *
 * Ordering matters: `[0]` is the default hat. Lowest level wins because the
 * most specific role is the one whose day-to-day work the app is for — a
 * Bacenta leader who also admins a stream spends most Sundays checking
 * themselves in, not supervising. Ties break leader-before-admin, then by
 * name, so the list is stable across logins even though the JWT gives no
 * ordering guarantee.
 *
 * Reads BOTH the `churchScopes` single-edge block and the top-level
 * `leads<Level>` / `isAdminFor<Level>` arrays, which the auth lambda populates
 * for users holding several edges at one level.
 *
 * Unlike the church-keyed version this replaces, a leader edge and an admin
 * edge pointing at the SAME church produce two distinct entries. They are two
 * different hats with different capabilities; merging them was the bug.
 */
export function getUserRoleScopes(user: AppUser | null | undefined): RoleScope[] {
  if (!user) return []

  const seen = new Set<string>()
  const out: RoleScope[] = []

  const push = (source: RoleScopeSource, level: ScopeLevel, id?: string, name?: string) => {
    if (typeof id !== 'string' || !id) return
    const key = roleScopeKey(source, level, id)
    if (seen.has(key)) return
    seen.add(key)
    const resolvedName = name || cap(level)
    out.push({ key, source, level, id, name: resolvedName, ...buildLabels(source, level, resolvedName) })
  }

  for (const level of ROLE_EDGE_LEVELS) {
    const cs = user.churchScopes as Record<string, { id: string; name?: string } | null | undefined> | undefined
    if (cs) {
      const leads = cs[`leads${cap(level)}Of`]
      if (leads?.id) push('leader', level, leads.id, leads.name)
      const admin = cs[`isAdminFor${cap(level)}Of`]
      if (admin?.id) push('admin', level, admin.id, admin.name)
    }

    const leadsArr = (user as any)[`leads${cap(level)}`]
    if (Array.isArray(leadsArr)) {
      for (const ref of leadsArr) push('leader', level, ref?.id, ref?.name)
    }
    const adminArr = (user as any)[`isAdminFor${cap(level)}`]
    if (Array.isArray(adminArr)) {
      for (const ref of adminArr) push('admin', level, ref?.id, ref?.name)
    }

    // Specialist edges (isArrivalsCounterFor<Level>Of, isTellerFor<Level>Of,
    // fishers) are intentionally NOT read here — see RoleScopeSource above.
  }

  const sourceRank: Record<RoleScopeSource, number> = { leader: 0, admin: 1 }
  return out.sort((a, b) => {
    const levelDiff = SCOPE_LEVELS.indexOf(a.level) - SCOPE_LEVELS.indexOf(b.level)
    if (levelDiff !== 0) return levelDiff
    const sourceDiff = sourceRank[a.source] - sourceRank[b.source]
    if (sourceDiff !== 0) return sourceDiff
    return a.name.localeCompare(b.name)
  })
}

/** The hat a user gets by default: their most specific role.
 *  Mirrors the portal's getLowestRole-based default. */
export function defaultRoleScope(user: AppUser | null | undefined): RoleScope | null {
  return getUserRoleScopes(user)[0] ?? null
}

/** Find a previously-selected hat in the user's current set.
 *  Returns null when the user no longer holds it (role removed between
 *  sessions), so callers fall back to the default rather than acting under an
 *  identity the JWT no longer supports. */
export function findRoleScope(
  scopes: RoleScope[],
  key: string | null | undefined,
): RoleScope | null {
  if (!key) return null
  return scopes.find((s) => s.key === key) ?? null
}

/** True when the user holds more than one hat and the switcher is meaningful. */
export function isMultiRole(scopes: RoleScope[]): boolean {
  return scopes.length > 1
}
