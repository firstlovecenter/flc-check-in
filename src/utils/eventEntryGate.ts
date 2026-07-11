import type { AppUser, ScopeLevel } from '../types/app'
import { SCOPE_LEVELS } from '../types/app'
import { getEventEntryState } from './supabaseCheckins'

export type EventEntryRoute = 'checkin' | 'dashboard' | 'home'

export interface EventEntryState {
  found: boolean
  eventStatus: string | null
  scopeLevel: string | null
  allowedRoles: string[]
  checkinOpen: boolean
  snapshotMemberId: string | null
  inSnapshot: boolean
  roleEligible: boolean
  eligibleForCheckin: boolean
  alreadyCheckedIn: boolean
}

const ROLE_SUFFIX = /^(leader|admin)(Bacenta|Governorship|Council|Stream|Campus|Oversight|Denomination)$/i

function roleLevelIndex(role: string): number {
  const m = ROLE_SUFFIX.exec(role)
  if (!m) return -1
  return SCOPE_LEVELS.indexOf(m[2].toLowerCase() as ScopeLevel)
}

function scopeLevelIndex(level: string | null | undefined): number {
  if (!level) return -1
  return SCOPE_LEVELS.indexOf(level as ScopeLevel)
}

/**
 * Highest church level the viewer oversees, from JWT roles, churchScopes,
 * top-level lead/admin edge arrays, and user.level.
 *
 * The entry gate must not trust `user.level` alone — it can lag behind
 * churchScopes / role arrays and wrongly classify a governorship/council
 * leader as bacenta (which hid IdentityRow / scope drills).
 */
export function viewerOversightLevelIndex(user: AppUser): number {
  let highest = -1

  const bump = (level: string | null | undefined) => {
    const idx = scopeLevelIndex(level)
    if (idx > highest) highest = idx
  }

  for (const role of user.roles || []) {
    if (typeof role !== 'string') continue
    const idx = roleLevelIndex(role)
    if (idx > highest) highest = idx
  }

  bump(user.level)

  const scopes = user.churchScopes
  if (scopes) {
    if (scopes.leadsBacentaOf?.id) bump('bacenta')
    if (scopes.leadsGovernorshipOf?.id || scopes.isAdminForGovernorshipOf?.id) bump('governorship')
    if (scopes.leadsCouncilOf?.id || scopes.isAdminForCouncilOf?.id) bump('council')
    if (scopes.leadsStreamOf?.id || scopes.isAdminForStreamOf?.id) bump('stream')
    if (scopes.leadsCampusOf?.id || scopes.isAdminForCampusOf?.id) bump('campus')
    if (scopes.leadsOversightOf?.id || scopes.isAdminForOversightOf?.id) bump('oversight')
    if (scopes.leadsDenominationOf?.id || scopes.isAdminForDenominationOf?.id) bump('denomination')
  }

  const edgePairs: Array<[ScopeLevel, Array<{ id: string }> | undefined]> = [
    ['bacenta', user.leadsBacenta],
    ['governorship', user.leadsGovernorship],
    ['governorship', user.isAdminForGovernorship],
    ['council', user.leadsCouncil],
    ['council', user.isAdminForCouncil],
    ['stream', user.leadsStream],
    ['stream', user.isAdminForStream],
    ['campus', user.leadsCampus],
    ['campus', user.isAdminForCampus],
    ['oversight', user.leadsOversight],
    ['oversight', user.isAdminForOversight],
    ['denomination', user.leadsDenomination],
    ['denomination', user.isAdminForDenomination],
  ]
  for (const [level, list] of edgePairs) {
    if (list?.length) bump(level)
  }

  for (const ctx of user.churchContexts || []) {
    bump(ctx.level)
  }
  bump(user.activeChurch?.level)

  return highest
}

/** Overseeing admins / ancestor-scope viewers load the dashboard first. */
export function isManagementViewer(
  user: AppUser,
  scopeLevel: string | null | undefined,
): boolean {
  if (user.isSuperAdmin || user.isSuperViewer) return true

  const eventIdx = scopeLevelIndex(scopeLevel)
  if (eventIdx < 0) return false

  for (const role of user.roles || []) {
    if (typeof role !== 'string') continue
    const roleIdx = roleLevelIndex(role)
    if (roleIdx < 0) continue
    if (/^admin/i.test(role) && roleIdx === eventIdx) return true
    if (roleIdx > eventIdx) return true
  }

  // churchScopes / edge arrays can show ancestor oversight when roles[] is thin.
  const oversightIdx = viewerOversightLevelIndex(user)
  if (oversightIdx > eventIdx) return true

  return false
}

export function normalizeEventEntryState(raw: any): EventEntryState {
  return {
    found: !!raw?.found,
    eventStatus: raw?.event_status ?? null,
    scopeLevel: raw?.scope_level ?? null,
    allowedRoles: Array.isArray(raw?.allowed_roles) ? raw.allowed_roles : [],
    checkinOpen: !!raw?.checkin_open,
    snapshotMemberId: raw?.snapshot_member_id ?? null,
    inSnapshot: !!raw?.in_snapshot,
    roleEligible: !!raw?.role_eligible,
    eligibleForCheckin: !!raw?.eligible_for_checkin,
    alreadyCheckedIn: !!raw?.already_checked_in,
  }
}

/**
 * True only for leaf attendees who have no child-scope drills to oversee.
 * Mid-level leaders (governorship+) always keep the dashboard — matching the
 * pre-gate EventDashboard redirects that keyed off viewerCaps.viewerScope.
 */
export function isAttendeeOnlyViewer(
  user: AppUser,
  entry: Pick<EventEntryState, 'scopeLevel' | 'allowedRoles'>,
): boolean {
  if (user.isSuperAdmin || user.isSuperViewer) return false
  if (isManagementViewer(user, entry.scopeLevel)) return false
  if (entry.scopeLevel === 'special_group') return true

  const oversightIdx = viewerOversightLevelIndex(user)
  // Unknown / bacenta-only → no IdentityRow child drills.
  if (oversightIdx <= scopeLevelIndex('bacenta')) return true

  // Anyone who oversees above bacenta keeps the dashboard (scope breakdown).
  // Do NOT use "lowest allowed role == user.level" — that mis-fired when JWT
  // level lagged behind real oversight and hid drills for mid-level leaders.
  return false
}

export interface EventEntryRouteOptions {
  /**
   * ScopeBreakdown drills into `/events/:id?scopeLevel=&scopeChurchId=`.
   * That is an explicit dashboard view — never redirect those to check-in.
   */
  hasScopeDrilldown?: boolean
}

export function resolveEventEntryRoute(
  user: AppUser,
  entry: EventEntryState,
  opts: EventEntryRouteOptions = {},
): EventEntryRoute {
  if (!entry.found) return 'dashboard'

  // Drill-down URLs are dashboard destinations, not event-open entry points.
  if (opts.hasScopeDrilldown) return 'dashboard'

  const management = isManagementViewer(user, entry.scopeLevel)
  const attendeeOnly = isAttendeeOnlyViewer(user, entry)

  if (entry.eventStatus === 'ENDED' && attendeeOnly && !management) {
    return 'home'
  }

  const needsCheckIn =
    entry.eligibleForCheckin
    && !entry.alreadyCheckedIn
    && entry.eventStatus === 'ACTIVE'
    && entry.checkinOpen
    && !management
    && attendeeOnly

  if (needsCheckIn) return 'checkin'
  return 'dashboard'
}

export function candidateMemberIds(user: AppUser): string[] {
  return [
    user.graphMemberId,
    user.userId,
  ].filter((id, idx, arr): id is string =>
    typeof id === 'string' && id.length > 0 && arr.indexOf(id) === idx,
  )
}

export async function loadEventEntryState(
  eventId: string,
  user: AppUser,
): Promise<EventEntryState> {
  const data = await getEventEntryState({
    eventId,
    memberIds: candidateMemberIds(user),
    email: user.email,
  })
  return normalizeEventEntryState(data)
}
