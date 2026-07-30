// Building an event's eligible-attendee snapshot from the FL member graph.
//
// The architectural rule this file exists to enforce
// --------------------------------------------------
// The graph is probed at exactly TWO moments, both administrative and both
// deliberate:
//
//   1. Event creation — snapshot who is in scope.
//   2. An explicit "Refresh eligible list" by an admin, when the roster has
//      changed since creation (someone promoted, someone moved).
//
// It is NEVER probed during a live event. Check-in eligibility is answered
// entirely from Postgres: submit_checkin → resolve_event_snapshot_member →
// event_scope_members ⋈ member_profiles. Login is already gated by the auth
// JWT, so a live service does not depend on Neo4j being up or fast — which
// matters most at precisely the moment it is under the heaviest load.
//
// The cost of that rule is that the snapshot is frozen between probes. The
// refresh path below is the sanctioned way to unfreeze it, replacing the old
// "add member to event scope" button that patched one person at a time.

import {
  getMembersInScope,
  memberToProfileRow,
} from './membersApi'
import {
  snapshotEventScopeMembers,
  bulkUpsertMemberProfiles,
  listSpecialGroupMembers,
  countEventScopeMembers,
} from './supabaseCheckins'

export interface ScopeRef { level: string; id: string }

export interface SnapshotResult {
  /** Members written to event_scope_members. */
  memberCount: number
  /** Snapshot size before this run — lets the UI report what changed. */
  previousCount: number
}

/**
 * Probe the graph for everyone in `scopes` and write the event's snapshot.
 *
 * Idempotent: snapshotEventScopeMembers upserts, so re-running only ever adds
 * newly-eligible members. It does NOT remove people who have since lost their
 * role — deliberately. Removing someone mid-event would revoke check-in from a
 * person who may already be standing in the queue, and attendance history for
 * an event they were legitimately invited to is worth more than a tidy roster.
 * Deactivated members are already blocked by the is_active gate in
 * resolve_event_snapshot_member, which is the correct place for that check.
 */
export async function snapshotEventScopeFromGraph(input: {
  eventId: string
  /** Church scopes to union members from. Ignored when groupIds is given. */
  scopes?: ScopeRef[]
  /** Special-group events take their membership from the groups instead. */
  groupIds?: string[]
}): Promise<SnapshotResult> {
  const { eventId, scopes = [], groupIds = [] } = input

  const previousCount = await countEventScopeMembers(eventId).catch(() => 0)

  let memberIds: string[] = []
  let profileRows: any[] = []

  if (groupIds.length > 0) {
    const results = await Promise.all(groupIds.map(listSpecialGroupMembers))
    const seen = new Set<string>()
    memberIds = results
      .flat()
      .filter((m) => {
        if (!m?.member_id || seen.has(m.member_id)) return false
        seen.add(m.member_id)
        return true
      })
      .map((m) => m.member_id)
  } else {
    const results = await Promise.all(
      scopes.map((s) => getMembersInScope({ level: s.level, churchId: s.id })),
    )
    const seen = new Set<string>()
    const unique = results.flat().filter((m: any) => {
      if (!m?.id || seen.has(m.id)) return false
      seen.add(m.id)
      return true
    })
    profileRows = unique.map(memberToProfileRow)
    memberIds = profileRows.map((r: any) => r.id).filter(Boolean)
  }

  await Promise.all([
    snapshotEventScopeMembers(eventId, memberIds),
    // Profiles carry roles and scope_paths, which the snapshot join needs to
    // answer eligibility — writing ids without them would leave the new members
    // in the snapshot but ineligible.
    profileRows.length ? bulkUpsertMemberProfiles(profileRows) : Promise.resolve(),
  ])

  return { memberCount: memberIds.length, previousCount }
}
