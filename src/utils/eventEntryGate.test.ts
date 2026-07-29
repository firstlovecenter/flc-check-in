// Tests for event entry routing under the role-scope ("hat") model.
//
// What this replaces
// ------------------
// Routing used to run through viewerOversightLevelIndex(), which scanned
// roles[], churchScopes, every leads*/isAdminFor* array, churchContexts and
// activeChurch, and returned the MAXIMUM church level found anywhere. Anyone
// above bacenta was then classed as "management" and sent to a dashboard.
//
// The consequence — the most-reported confusion in the app — was that a
// Bacenta leader who ALSO held a stream or council admin edge could never be
// routed to check in. They opened a bacenta event they were personally
// expected at and got a supervisor's dashboard, with no way to say otherwise.
//
// Those helpers are gone. Routing is now a function of the ONE hat the user is
// wearing plus the server's answer for where that hat sits relative to the
// event. These tests pin that.

import { describe, expect, it } from 'vitest'
import {
  normalizeEventEntryState,
  resolveEventEntryRoute,
  capsForEntry,
  candidateMemberIds,
  type EventEntryState,
} from './eventEntryGate'
import type { RoleScope } from './roleScopes'
import type { AppUser } from '../types/app'

const makeUser = (overrides: Partial<AppUser> = {}): AppUser => ({
  userId: 'u-1',
  roles: [],
  isAdmin: false,
  ...overrides,
}) as AppUser

const hat = (source: 'leader' | 'admin', level: string, id: string, name = 'A Church'): RoleScope => ({
  key: `${source}:${level}:${id}`,
  source,
  level: level as any,
  id,
  name,
  roleLabel: `${level} ${source}`,
  displayName: `${level} ${source} · ${name}`,
})

const entry = (overrides: Partial<EventEntryState> = {}): EventEntryState => ({
  found: true,
  eventStatus: 'ACTIVE',
  scopeLevel: 'governorship',
  scopeChurchId: 'gov-1',
  scopeChurchName: 'Emmanuel',
  allowedRoles: ['leaderBacenta'],
  checkinOpen: true,
  snapshotMemberId: 'm-1',
  inSnapshot: true,
  roleEligible: true,
  eligibleForCheckin: true,
  alreadyCheckedIn: false,
  scopeRelation: 'descendant',
  scopeRelationVerified: true,
  ...overrides,
})

describe('normalizeEventEntryState', () => {
  it('maps the RPC payload including the scope relation', () => {
    const state = normalizeEventEntryState({
      found: true,
      event_status: 'ACTIVE',
      scope_level: 'governorship',
      scope_church_id: 'gov-1',
      scope_church_name: 'Emmanuel',
      allowed_roles: ['leaderBacenta'],
      checkin_open: true,
      snapshot_member_id: 'm-1',
      in_snapshot: true,
      role_eligible: true,
      eligible_for_checkin: true,
      already_checked_in: false,
      scope_relation: 'ancestor',
      scope_relation_verified: false,
    })
    expect(state.scopeRelation).toBe('ancestor')
    expect(state.scopeRelationVerified).toBe(false)
    expect(state.scopeChurchName).toBe('Emmanuel')
  })

  it('falls back to "unrelated" for an unrecognised relation', () => {
    expect(normalizeEventEntryState({ found: true, scope_relation: 'nonsense' }).scopeRelation)
      .toBe('unrelated')
  })

  it('treats a missing verified flag as proven, so a pre-036 backend is unchanged', () => {
    expect(normalizeEventEntryState({ found: true }).scopeRelationVerified).toBe(true)
  })
})

describe('routing — the regression this model exists for', () => {
  it('routes a bacenta leader to check-in even when they also hold a higher admin edge', () => {
    // Under the old max-of-all-roles rule this user was permanently
    // "management" and never saw a scanner.
    const multiRoleUser = makeUser({
      roles: ['leaderBacenta', 'adminStream'],
      churchScopes: {
        leadsBacentaOf: { id: 'bac-1', name: 'Bacenta B' },
        isAdminForStreamOf: { id: 'stream-9', name: 'Another Stream' },
      },
    } as any)

    expect(resolveEventEntryRoute(
      multiRoleUser,
      hat('leader', 'bacenta', 'bac-1', 'Bacenta B'),
      entry({ scopeRelation: 'descendant' }),
    )).toBe('checkin')
  })

  it('routes the same person to the dashboard once they switch to the admin hat', () => {
    expect(resolveEventEntryRoute(
      makeUser(),
      hat('admin', 'stream', 'stream-1'),
      entry({ scopeRelation: 'ancestor', eligibleForCheckin: false }),
    )).toBe('dashboard')
  })

  it('routes an admin at the event scope to the dashboard', () => {
    expect(resolveEventEntryRoute(
      makeUser(), hat('admin', 'governorship', 'gov-1'),
      entry({ scopeRelation: 'exact', eligibleForCheckin: false }),
    )).toBe('dashboard')
  })

  it('does not send an already-checked-in attendee back to the scanner', () => {
    expect(resolveEventEntryRoute(
      makeUser(), hat('leader', 'bacenta', 'bac-1'),
      entry({ alreadyCheckedIn: true }),
    )).toBe('dashboard')
  })

  it('does not route to check-in before the window opens', () => {
    expect(resolveEventEntryRoute(
      makeUser(), hat('leader', 'bacenta', 'bac-1'),
      entry({ checkinOpen: false }),
    )).toBe('dashboard')
  })

  it('keeps scope drill-downs on the dashboard', () => {
    expect(resolveEventEntryRoute(
      makeUser(), hat('leader', 'bacenta', 'bac-1'), entry(), { hasScopeDrilldown: true },
    )).toBe('dashboard')
  })

  it('falls back to the dashboard when the event was not found', () => {
    expect(resolveEventEntryRoute(
      makeUser(), hat('leader', 'bacenta', 'bac-1'), entry({ found: false }),
    )).toBe('dashboard')
  })
})

describe('capsForEntry — unverified containment', () => {
  it('an ancestor admin keeps visibility but loses management when containment is unproven', () => {
    // church_hierarchy is an opportunistic cache and migration 034 empties its
    // parent links. Until it refills, containment can be genuinely unknown —
    // we must not lock a supervisor out, nor hand them control of an event
    // that may not be theirs.
    const caps = capsForEntry(
      makeUser(),
      hat('admin', 'stream', 'stream-1'),
      entry({ scopeRelation: 'ancestor', scopeRelationVerified: false }),
    )
    expect(caps.canView).toBe(true)
    expect(caps.canViewFullEvent).toBe(true)
    expect(caps.canManage).toBe(false)
    expect(caps.canManuallyCheckIn).toBe(false)
  })

  it('grants management once containment is proven', () => {
    const caps = capsForEntry(
      makeUser(),
      hat('admin', 'stream', 'stream-1'),
      entry({ scopeRelation: 'ancestor', scopeRelationVerified: true }),
    )
    expect(caps.canManage).toBe(true)
  })

  it('grants nothing on an unrelated branch', () => {
    const caps = capsForEntry(
      makeUser(), hat('leader', 'bacenta', 'elsewhere'),
      entry({ scopeRelation: 'unrelated', eligibleForCheckin: false }),
    )
    expect(caps.canView).toBe(false)
    expect(caps.canManage).toBe(false)
    expect(caps.canCheckIn).toBe(false)
  })

  it('superadmin manages regardless of hat', () => {
    const caps = capsForEntry(
      makeUser({ isSuperAdmin: true }), null,
      entry({ scopeRelation: 'unrelated' }),
    )
    expect(caps.canManage).toBe(true)
  })
})

describe('candidateMemberIds', () => {
  it('dedupes when the graph id and auth id are the same', () => {
    expect(candidateMemberIds(makeUser({ graphMemberId: 'g-1', userId: 'g-1' } as any)))
      .toEqual(['g-1'])
  })

  it('returns both ids when they differ, graph id first', () => {
    expect(candidateMemberIds(makeUser({ graphMemberId: 'g-1', userId: 'u-1' } as any)))
      .toEqual(['g-1', 'u-1'])
  })
})
