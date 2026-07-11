import { describe, expect, it } from 'vitest'
import type { AppUser } from '../types/app'
import {
  isAttendeeOnlyViewer,
  isManagementViewer,
  normalizeEventEntryState,
  resolveEventEntryRoute,
  viewerOversightLevelIndex,
  type EventEntryState,
} from './eventEntryGate'

function makeUser(overrides: Partial<AppUser> = {}): AppUser {
  return {
    userId: 'auth-1',
    email: 'leader@example.com',
    roles: ['leaderBacenta'],
    level: 'bacenta',
    isAdmin: false,
    ...overrides,
  }
}

function makeEntry(overrides: Partial<EventEntryState> = {}): EventEntryState {
  return {
    ...normalizeEventEntryState({
      found: true,
      event_status: 'ACTIVE',
      scope_level: 'council',
      allowed_roles: ['leaderBacenta', 'leaderGovernorship', 'leaderCouncil'],
      checkin_open: true,
      in_snapshot: true,
      role_eligible: true,
      eligible_for_checkin: true,
      already_checked_in: false,
    }),
    ...overrides,
  }
}

describe('resolveEventEntryRoute', () => {
  it('routes an eligible bacenta leader to check-in before dashboard', () => {
    const route = resolveEventEntryRoute(
      makeUser({ level: 'bacenta', roles: ['leaderBacenta'] }),
      makeEntry(),
    )
    expect(route).toBe('checkin')
  })

  it('routes an already-checked-in leader to the dashboard', () => {
    const route = resolveEventEntryRoute(
      makeUser({ level: 'bacenta', roles: ['leaderBacenta'] }),
      makeEntry({ alreadyCheckedIn: true }),
    )
    expect(route).toBe('dashboard')
  })

  it('routes an overseeing stream admin straight to the dashboard', () => {
    const route = resolveEventEntryRoute(
      makeUser({ level: 'stream', roles: ['adminStream'] }),
      makeEntry(),
    )
    expect(route).toBe('dashboard')
  })

  it('keeps a council leader on the dashboard so scope drill-downs remain available', () => {
    const route = resolveEventEntryRoute(
      makeUser({ level: 'council', roles: ['leaderCouncil'] }),
      makeEntry({
        scopeLevel: 'council',
        eligibleForCheckin: true,
        alreadyCheckedIn: false,
      }),
    )
    expect(route).toBe('dashboard')
  })

  it('keeps a governorship leader on the dashboard even when eligible to check in', () => {
    const route = resolveEventEntryRoute(
      makeUser({ level: 'governorship', roles: ['leaderGovernorship'] }),
      makeEntry({
        scopeLevel: 'council',
        eligibleForCheckin: true,
        alreadyCheckedIn: false,
      }),
    )
    expect(route).toBe('dashboard')
  })

  it('keeps mid-level leaders on the dashboard when JWT level lags behind churchScopes', () => {
    const route = resolveEventEntryRoute(
      makeUser({
        level: 'bacenta',
        roles: ['leaderBacenta'],
        churchScopes: {
          leadsGovernorshipOf: { id: 'gov-1', name: 'Gov One' },
        },
      }),
      makeEntry({ eligibleForCheckin: true, alreadyCheckedIn: false }),
    )
    expect(route).toBe('dashboard')
  })

  it('routes ended special-group attendees home instead of dashboard', () => {
    const route = resolveEventEntryRoute(
      makeUser({ level: 'bacenta', roles: ['leaderBacenta'] }),
      makeEntry({
        scopeLevel: 'special_group',
        eventStatus: 'ENDED',
        checkinOpen: false,
      }),
    )
    expect(route).toBe('home')
  })

  it('keeps superadmins on the dashboard even when eligible', () => {
    const route = resolveEventEntryRoute(
      makeUser({ isSuperAdmin: true, roles: ['superAdmin'] }),
      makeEntry({ eligibleForCheckin: true }),
    )
    expect(route).toBe('dashboard')
  })

  it('keeps scope drill-downs on the dashboard even when check-in is still due', () => {
    const route = resolveEventEntryRoute(
      makeUser({ level: 'bacenta', roles: ['leaderBacenta'] }),
      makeEntry({ eligibleForCheckin: true, alreadyCheckedIn: false }),
      { hasScopeDrilldown: true },
    )
    expect(route).toBe('dashboard')
  })
})

describe('viewerOversightLevelIndex', () => {
  it('prefers churchScopes over a stale bacenta level', () => {
    expect(viewerOversightLevelIndex(makeUser({
      level: 'bacenta',
      roles: ['leaderBacenta'],
      churchScopes: { leadsCouncilOf: { id: 'c1', name: 'Council' } },
    }))).toBeGreaterThan(0)
  })
})

describe('isAttendeeOnlyViewer', () => {
  it('treats bacenta-only leaders as attendees', () => {
    expect(isAttendeeOnlyViewer(
      makeUser({ level: 'bacenta', roles: ['leaderBacenta'] }),
      makeEntry(),
    )).toBe(true)
  })

  it('does not treat governorship leaders as attendees', () => {
    expect(isAttendeeOnlyViewer(
      makeUser({ level: 'governorship', roles: ['leaderGovernorship'] }),
      makeEntry(),
    )).toBe(false)
  })
})

describe('isManagementViewer', () => {
  it('treats exact-scope admins as management viewers', () => {
    expect(isManagementViewer(
      makeUser({ roles: ['adminCouncil'], level: 'council' }),
      'council',
    )).toBe(true)
  })

  it('treats ancestor-scope leaders as management viewers', () => {
    expect(isManagementViewer(
      makeUser({ roles: ['leaderStream'], level: 'stream' }),
      'council',
    )).toBe(true)
  })
})
