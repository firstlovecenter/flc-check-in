// What may the viewer do on this event, wearing this hat?
//
// Why this is a pure function
// ---------------------------
// Capability used to be decided by a cascade inside useEventEligibility:
// getViewerCapabilities (needs a live Neo4j viewer node) → fallbackCapsFromUser
// → a third reconstruction from JWT scopes. Three code paths could produce
// `viewerCaps`, and WHICH one ran depended on whether the graph answered in
// time. The same user, on the same event, got different UI depending on the
// network. That is not a permissions model, it is a race.
//
// The FL Admin Portal's `permit*` helpers are pure functions of role strings
// and cannot behave that way. This is the Hineni equivalent: everything it
// needs is passed in, nothing is fetched, and it is exhaustively testable.
//
// The graph's job is to supply DATA (which churches contain which). Deciding
// what that data permits happens here.

import type { RoleScope } from './roleScopes'

/** How the viewer's hat sits relative to the event's scope.
 *
 *  Resolved by the caller from scope_paths / the ancestor chain — kept out of
 *  this module so capability stays a pure decision over an already-known fact.
 *
 *    exact      — the hat's church IS the event's church
 *    ancestor   — the hat's church CONTAINS the event's church (supervising)
 *    descendant — the hat's church is INSIDE the event's church (attending)
 *    unrelated  — different branch of the tree entirely
 */
export type ScopeRelation = 'exact' | 'ancestor' | 'descendant' | 'unrelated'

export interface ViewerScope {
  level: string
  id: string
  name: string
}

export interface ViewerCaps {
  /** Pause/resume/end/edit the event, see admin controls. */
  canManage: boolean
  /** Personally check in to this event. */
  canCheckIn: boolean
  /** See the event at all. */
  canView: boolean
  /** See every attendee, not just the viewer's own slice. */
  canViewFullEvent: boolean
  /** Check someone else in manually. */
  canManuallyCheckIn: boolean
  /** Which slice of the event the dashboard should centre on. */
  viewerScope: ViewerScope | null
}

const NO_CAPS: ViewerCaps = {
  canManage: false,
  canCheckIn: false,
  canView: false,
  canViewFullEvent: false,
  canManuallyCheckIn: false,
  viewerScope: null,
}

export interface CapsInput {
  /** The hat the viewer is currently wearing. null = "All roles" browse mode. */
  hat: RoleScope | null
  event: {
    scope_level: string
    scope_church_id: string
    scope_church_name?: string
  }
  /** Where the hat sits relative to the event. Ignored when hat is null. */
  relation: ScopeRelation
  /** False when the server could not PROVE containment because the
   *  church_hierarchy cache is incomplete (see migration 036).
   *
   *  An unverified ancestor keeps visibility and loses management: failing
   *  closed would strip supervisors of access mid-service, failing open would
   *  hand event control to someone who may not own it. Defaults to true so
   *  callers that don't supply it are unaffected. */
  relationVerified?: boolean
  /** Server's answer (from the entry gate) to "is this person in the event's
   *  eligible snapshot?". Capability never re-derives eligibility — the
   *  snapshot is authoritative and lives in Postgres. */
  eligibleForCheckin: boolean
  isSuperAdmin?: boolean
  isSuperViewer?: boolean
}

export function capsFor(input: CapsInput): ViewerCaps {
  const { hat, event, relation, eligibleForCheckin } = input

  const eventScope: ViewerScope = {
    level: event.scope_level,
    id: event.scope_church_id,
    name: event.scope_church_name ?? '',
  }

  // Superadmin bypasses scope entirely — but NOT the event's own eligibility
  // rule. Being able to manage everything does not make you an expected
  // attendee of everything.
  if (input.isSuperAdmin) {
    return {
      canManage: true,
      canCheckIn: eligibleForCheckin,
      canView: true,
      canViewFullEvent: true,
      canManuallyCheckIn: true,
      viewerScope: eventScope,
    }
  }

  // Superviewer is superadmin for reads, nothing for writes.
  if (input.isSuperViewer) {
    return {
      canManage: false,
      canCheckIn: false,
      canView: true,
      canViewFullEvent: true,
      canManuallyCheckIn: false,
      viewerScope: eventScope,
    }
  }

  // "All roles" browse mode. Deliberately read-only: with several hats active
  // at once there is no single answer to "may I check in here?", and guessing
  // is what produced the original confusion. The UI offers a hat to switch to.
  if (!hat) return NO_CAPS

  if (relation === 'unrelated') return NO_CAPS

  // ── The hat sits exactly at the event's scope ────────────────────────────
  //
  // canCheckIn is ALWAYS the server's answer, for every hat type.
  //
  // This used to hardcode `canCheckIn: false` for admin hats on the reasoning
  // that "admins run the event, they are not attendees of it". That is not the
  // app's rule to make: whether someone is expected at an event is stated by
  // the event's own allowed_roles, evaluated server-side against the scope
  // snapshot (see resolve_event_snapshot_member + roles_overlap_allowed).
  // Events here routinely DO list admin roles — the campus event that surfaced
  // this has allowed_roles including adminStream — so the veto silently
  // contradicted the event creator's explicit policy.
  //
  // Running an event and attending it are independent facts. The hat decides
  // management and visibility; allowed_roles decides attendance.
  if (relation === 'exact') {
    if (hat.source === 'admin') {
      return {
        canManage: true,
        canCheckIn: eligibleForCheckin,
        canView: true,
        canViewFullEvent: true,
        canManuallyCheckIn: true,
        viewerScope: eventScope,
      }
    }
    // Leader / specialist at exactly this church: an expected attendee who can
    // also see the whole register.
    return {
      canManage: false,
      canCheckIn: eligibleForCheckin,
      canView: true,
      canViewFullEvent: true,
      canManuallyCheckIn: false,
      viewerScope: eventScope,
    }
  }

  // ── The hat is ABOVE the event — supervising ─────────────────────────────
  if (relation === 'ancestor') {
    // Management requires PROVEN containment. When the hierarchy cache could
    // not confirm the event sits under this hat's church, the viewer still
    // sees the event (so a supervisor is never locked out mid-service) but
    // cannot pause, end, or edit it.
    const proven = input.relationVerified !== false
    const manages = hat.source === 'admin' && proven
    return {
      canManage: manages,
      // Still the server's answer. An ancestor is normally outside the event's
      // scope snapshot and so ineligible anyway — but if the snapshot DOES
      // include them, the snapshot is right and we defer to it rather than
      // second-guessing from the hierarchy.
      canCheckIn: eligibleForCheckin,
      canView: true,
      canViewFullEvent: true,
      canManuallyCheckIn: manages,
      viewerScope: eventScope,
    }
  }

  // ── The hat is BELOW the event — attending, and sees their own slice ─────
  //
  // This is the case the old entry gate got wrong. It took the MAXIMUM level
  // across every role the user held, so a Bacenta leader who also happened to
  // hold a stream admin edge was classed as management and sent to a
  // dashboard — for an event they were personally supposed to check in to.
  // Wearing the bacenta hat, the answer is unambiguous: check in.
  return {
    canManage: false,
    canCheckIn: eligibleForCheckin,
    canView: true,
    canViewFullEvent: false,
    canManuallyCheckIn: false,
    viewerScope: { level: hat.level, id: hat.id, name: hat.name },
  }
}

/** Where the viewer should land when they open this event.
 *
 *  Replaces resolveEventEntryRoute's max-of-all-roles logic. The question is
 *  now local and answerable: wearing THIS hat, am I here to be counted or to
 *  supervise?
 */
export type EventEntryRoute = 'checkin' | 'dashboard' | 'home'

export function routeForCaps(input: {
  caps: ViewerCaps
  eventStatus: string | null
  checkinOpen: boolean
  alreadyCheckedIn: boolean
  /** ScopeBreakdown drill-downs are explicit dashboard destinations. */
  hasScopeDrilldown?: boolean
}): EventEntryRoute {
  const { caps, eventStatus, checkinOpen, alreadyCheckedIn } = input

  if (input.hasScopeDrilldown) return 'dashboard'

  // Someone who can only check in has nothing to look at once the event is
  // over. Anyone with a view of the register keeps it.
  if (eventStatus === 'ENDED' && !caps.canView) return 'home'

  const needsCheckIn =
    caps.canCheckIn
    && !alreadyCheckedIn
    && eventStatus === 'ACTIVE'
    && checkinOpen
    && !caps.canManage

  return needsCheckIn ? 'checkin' : 'dashboard'
}
