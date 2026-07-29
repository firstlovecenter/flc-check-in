// Tests for the pure capability model.
//
// The behaviour these lock in is the fix for the app's longest-standing
// confusion: a leader who ALSO holds a higher admin edge was routed to a
// dashboard for events they were personally supposed to attend, because
// capability was derived from the maximum of every role they held anywhere.
// Wearing one hat at a time, the answer is local and unambiguous.

import { describe, it, expect } from 'vitest'
import { capsFor, routeForCaps } from './eventCaps'
import type { RoleScope } from './roleScopes'

const hat = (source: 'leader' | 'admin', level: string, id: string, name = 'A Church'): RoleScope => ({
  key: `${source}:${level}:${id}`,
  source,
  level: level as any,
  id,
  name,
  roleLabel: `${level} ${source}`,
  displayName: `${level} ${source} · ${name}`,
})

const event = {
  scope_level: 'governorship',
  scope_church_id: 'gov-1',
  scope_church_name: 'Emmanuel',
}

describe('capsFor — exact scope match', () => {
  it('an admin at the event scope manages it and is not an attendee', () => {
    const caps = capsFor({
      hat: hat('admin', 'governorship', 'gov-1'),
      event, relation: 'exact', eligibleForCheckin: true,
    })
    expect(caps.canManage).toBe(true)
    expect(caps.canManuallyCheckIn).toBe(true)
    expect(caps.canCheckIn).toBe(false)
    expect(caps.canViewFullEvent).toBe(true)
  })

  it('a leader at the event scope checks in and sees the whole register', () => {
    const caps = capsFor({
      hat: hat('leader', 'governorship', 'gov-1'),
      event, relation: 'exact', eligibleForCheckin: true,
    })
    expect(caps.canCheckIn).toBe(true)
    expect(caps.canManage).toBe(false)
    expect(caps.canViewFullEvent).toBe(true)
    expect(caps.canManuallyCheckIn).toBe(false)
  })

  it('never grants check-in when the server says the viewer is not eligible', () => {
    const caps = capsFor({
      hat: hat('leader', 'governorship', 'gov-1'),
      event, relation: 'exact', eligibleForCheckin: false,
    })
    expect(caps.canCheckIn).toBe(false)
    expect(caps.canView).toBe(true)
  })
})

describe('capsFor — hat above the event (supervising)', () => {
  it('an ancestor admin manages without being counted as present', () => {
    const caps = capsFor({
      hat: hat('admin', 'stream', 'stream-1'),
      event, relation: 'ancestor', eligibleForCheckin: true,
    })
    expect(caps.canManage).toBe(true)
    expect(caps.canCheckIn).toBe(false)
    expect(caps.canViewFullEvent).toBe(true)
  })

  it('an ancestor leader observes but does not manage', () => {
    const caps = capsFor({
      hat: hat('leader', 'stream', 'stream-1'),
      event, relation: 'ancestor', eligibleForCheckin: true,
    })
    expect(caps.canManage).toBe(false)
    expect(caps.canView).toBe(true)
    expect(caps.canViewFullEvent).toBe(true)
    expect(caps.canCheckIn).toBe(false)
  })
})

describe('capsFor — hat below the event (attending)', () => {
  // THE regression this whole model exists for.
  it('a bacenta leader inside the event scope checks in, even when they hold a higher admin edge elsewhere', () => {
    const caps = capsFor({
      hat: hat('leader', 'bacenta', 'bac-1', 'Bacenta B'),
      event, relation: 'descendant', eligibleForCheckin: true,
    })
    expect(caps.canCheckIn).toBe(true)
    expect(caps.canManage).toBe(false)
    // They see their own slice, not the whole governorship.
    expect(caps.canViewFullEvent).toBe(false)
    expect(caps.viewerScope).toEqual({ level: 'bacenta', id: 'bac-1', name: 'Bacenta B' })
  })
})

describe('capsFor — no capability', () => {
  it('grants nothing for an unrelated branch of the tree', () => {
    const caps = capsFor({
      hat: hat('leader', 'bacenta', 'bac-elsewhere'),
      event, relation: 'unrelated', eligibleForCheckin: true,
    })
    expect(caps).toMatchObject({ canView: false, canCheckIn: false, canManage: false })
  })

  it('"All roles" browse mode is read-only — no hat means no answer', () => {
    // With several hats active at once there is no single answer to "may I
    // check in here?". The UI offers a specific hat to switch to instead.
    const caps = capsFor({ hat: null, event, relation: 'exact', eligibleForCheckin: true })
    expect(caps.canCheckIn).toBe(false)
    expect(caps.canManage).toBe(false)
  })
})

describe('capsFor — super roles', () => {
  it('superadmin manages any event regardless of hat or relation', () => {
    const caps = capsFor({
      hat: null, event, relation: 'unrelated',
      eligibleForCheckin: false, isSuperAdmin: true,
    })
    expect(caps.canManage).toBe(true)
    expect(caps.canViewFullEvent).toBe(true)
  })

  it('superadmin still cannot check in to an event they are not eligible for', () => {
    const caps = capsFor({
      hat: null, event, relation: 'unrelated',
      eligibleForCheckin: false, isSuperAdmin: true,
    })
    expect(caps.canCheckIn).toBe(false)
  })

  it('superviewer sees everything and writes nothing', () => {
    const caps = capsFor({
      hat: null, event, relation: 'unrelated',
      eligibleForCheckin: true, isSuperViewer: true,
    })
    expect(caps.canView).toBe(true)
    expect(caps.canViewFullEvent).toBe(true)
    expect(caps.canManage).toBe(false)
    expect(caps.canCheckIn).toBe(false)
    expect(caps.canManuallyCheckIn).toBe(false)
  })
})

describe('routeForCaps', () => {
  const attendee = capsFor({
    hat: hat('leader', 'bacenta', 'bac-1'),
    event, relation: 'descendant', eligibleForCheckin: true,
  })
  const manager = capsFor({
    hat: hat('admin', 'governorship', 'gov-1'),
    event, relation: 'exact', eligibleForCheckin: false,
  })

  it('sends an eligible attendee to check-in on a live event', () => {
    expect(routeForCaps({
      caps: attendee, eventStatus: 'ACTIVE', checkinOpen: true, alreadyCheckedIn: false,
    })).toBe('checkin')
  })

  it('sends an already-checked-in attendee to the dashboard, not back to the scanner', () => {
    expect(routeForCaps({
      caps: attendee, eventStatus: 'ACTIVE', checkinOpen: true, alreadyCheckedIn: true,
    })).toBe('dashboard')
  })

  it('sends a manager to the dashboard even while check-in is open', () => {
    expect(routeForCaps({
      caps: manager, eventStatus: 'ACTIVE', checkinOpen: true, alreadyCheckedIn: false,
    })).toBe('dashboard')
  })

  it('does not send anyone to check-in before the window opens', () => {
    expect(routeForCaps({
      caps: attendee, eventStatus: 'ACTIVE', checkinOpen: false, alreadyCheckedIn: false,
    })).toBe('dashboard')
  })

  it('keeps drill-down URLs on the dashboard', () => {
    expect(routeForCaps({
      caps: attendee, eventStatus: 'ACTIVE', checkinOpen: true,
      alreadyCheckedIn: false, hasScopeDrilldown: true,
    })).toBe('dashboard')
  })

  it('sends a viewer with no visibility home once the event has ended', () => {
    const nobody = capsFor({
      hat: hat('leader', 'bacenta', 'x'), event, relation: 'unrelated', eligibleForCheckin: false,
    })
    expect(routeForCaps({
      caps: nobody, eventStatus: 'ENDED', checkinOpen: false, alreadyCheckedIn: false,
    })).toBe('home')
  })
})
