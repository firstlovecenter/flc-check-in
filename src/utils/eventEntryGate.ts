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

const ROLE_SUFFIX = /^(leader|admin)(Bacenta|Governorship|Council|Stream|Campus|Oversight|Denomination)$/

function roleLevelIndex(role: string): number {
  const m = ROLE_SUFFIX.exec(role)
  if (!m) return -1
  return SCOPE_LEVELS.indexOf(m[2].toLowerCase() as ScopeLevel)
}

function scopeLevelIndex(level: string | null | undefined): number {
  if (!level) return -1
  return SCOPE_LEVELS.indexOf(level as ScopeLevel)
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
    if (role.startsWith('admin') && roleIdx === eventIdx) return true
    if (roleIdx > eventIdx) return true
  }

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

function isLowestAllowedRole(user: AppUser, allowedRoles: string[]): boolean {
  if (!allowedRoles.length || !user.level) return false

  let lowestIdx = Infinity
  for (const role of allowedRoles) {
    const idx = roleLevelIndex(role)
    if (idx >= 0 && idx < lowestIdx) lowestIdx = idx
  }
  if (lowestIdx === Infinity) return false

  return scopeLevelIndex(user.level) === lowestIdx
}

export function resolveEventEntryRoute(
  user: AppUser,
  entry: EventEntryState,
): EventEntryRoute {
  if (!entry.found) return 'dashboard'

  const management = isManagementViewer(user, entry.scopeLevel)
  const attendeeOnly =
    entry.scopeLevel === 'special_group'
    || (user.level === 'bacenta' && !management)
    || isLowestAllowedRole(user, entry.allowedRoles)

  if (entry.eventStatus === 'ENDED' && attendeeOnly && !management) {
    return 'home'
  }

  const needsCheckIn =
    entry.eligibleForCheckin
    && !entry.alreadyCheckedIn
    && entry.eventStatus === 'ACTIVE'
    && entry.checkinOpen
    && !management

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
