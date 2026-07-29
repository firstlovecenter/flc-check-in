// Where should this viewer land when they open an event?
//
// The answer used to be derived from viewerOversightLevelIndex(): the MAXIMUM
// church level across every role the user held, anywhere in the graph. That
// made a Bacenta leader who also held a stream admin edge "management" for
// every event at or below stream — including bacenta events they were
// personally supposed to check in to. They got a dashboard instead of a
// scanner, and no way to tell the app it was wrong.
//
// Now the question is local: wearing THIS hat, am I here to be counted or to
// supervise? Capability comes from capsFor() (a pure function), containment
// from the server (migration 036), and routing falls out of both.

import type { AppUser } from '../types/app'
import type { RoleScope } from './roleScopes'
import { capsFor, routeForCaps, type ScopeRelation, type ViewerCaps } from './eventCaps'
import { getEventEntryState } from './supabaseCheckins'

export type { EventEntryRoute } from './eventCaps'

export interface EventEntryState {
  found: boolean
  eventStatus: string | null
  scopeLevel: string | null
  scopeChurchId: string | null
  scopeChurchName: string | null
  allowedRoles: string[]
  checkinOpen: boolean
  snapshotMemberId: string | null
  inSnapshot: boolean
  roleEligible: boolean
  eligibleForCheckin: boolean
  alreadyCheckedIn: boolean
  /** Where the requested hat sits relative to this event (migration 036). */
  scopeRelation: ScopeRelation
  /** False when containment could not be proven from the hierarchy cache. */
  scopeRelationVerified: boolean
}

const VALID_RELATIONS: ScopeRelation[] = ['exact', 'ancestor', 'descendant', 'unrelated']

function normalizeRelation(raw: any): ScopeRelation {
  return VALID_RELATIONS.includes(raw) ? raw : 'unrelated'
}

export function normalizeEventEntryState(raw: any): EventEntryState {
  return {
    found: !!raw?.found,
    eventStatus: raw?.event_status ?? null,
    scopeLevel: raw?.scope_level ?? null,
    scopeChurchId: raw?.scope_church_id ?? null,
    scopeChurchName: raw?.scope_church_name ?? null,
    allowedRoles: Array.isArray(raw?.allowed_roles) ? raw.allowed_roles : [],
    checkinOpen: !!raw?.checkin_open,
    snapshotMemberId: raw?.snapshot_member_id ?? null,
    inSnapshot: !!raw?.in_snapshot,
    roleEligible: !!raw?.role_eligible,
    eligibleForCheckin: !!raw?.eligible_for_checkin,
    alreadyCheckedIn: !!raw?.already_checked_in,
    scopeRelation: normalizeRelation(raw?.scope_relation),
    // Absent on responses from a pre-036 database: treat as proven so an older
    // backend behaves exactly as before rather than silently demoting admins.
    scopeRelationVerified: raw?.scope_relation_verified !== false,
  }
}

/** Capabilities for a viewer wearing `hat` on the event described by `entry`. */
export function capsForEntry(
  user: AppUser,
  hat: RoleScope | null,
  entry: EventEntryState,
): ViewerCaps {
  return capsFor({
    hat,
    event: {
      scope_level: entry.scopeLevel ?? '',
      scope_church_id: entry.scopeChurchId ?? '',
      scope_church_name: entry.scopeChurchName ?? undefined,
    },
    relation: entry.scopeRelation,
    relationVerified: entry.scopeRelationVerified,
    eligibleForCheckin: entry.eligibleForCheckin,
    isSuperAdmin: !!user.isSuperAdmin,
    isSuperViewer: !!user.isSuperViewer,
  })
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
  hat: RoleScope | null,
  entry: EventEntryState,
  opts: EventEntryRouteOptions = {},
) {
  if (!entry.found) return 'dashboard' as const
  return routeForCaps({
    caps: capsForEntry(user, hat, entry),
    eventStatus: entry.eventStatus,
    checkinOpen: entry.checkinOpen,
    alreadyCheckedIn: entry.alreadyCheckedIn,
    hasScopeDrilldown: opts.hasScopeDrilldown,
  })
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
  hat?: RoleScope | null,
): Promise<EventEntryState> {
  const data = await getEventEntryState({
    eventId,
    memberIds: candidateMemberIds(user),
    email: user.email,
    hatLevel: hat?.level ?? null,
    hatId: hat?.id ?? null,
  })
  return normalizeEventEntryState(data)
}
