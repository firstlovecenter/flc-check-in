// Tests for the post-fetch event-relevance gate.
//
// `isEventRelevantToUser` is the SECOND visibility check. The first is the
// PostgREST scope filter built by buildScopeOrFilter — it narrows to events
// whose scope_church_id appears in the user's hierarchy. This function then
// filters that result by allowed_roles, so that a "stream-leaders only" event
// hides from a campus admin who happens to be structurally above it but isn't
// invited.
//
// Rules under test (from supabaseCheckins.ts):
//   1. superAdmins see everything.
//   2. Event is visible if the user holds ANY role in allowed_roles.
//   3. Otherwise, visible if allowed_roles contains NO admin role
//      ("pure-leader event" — visible to anyone structurally in scope).
//   4. Otherwise, hidden.

import { describe, it, expect } from 'vitest'
import { isEventRelevantToUser } from './supabaseCheckins'
import type { AppUser } from '../types/app'

const baseUser = (overrides: Partial<AppUser> = {}): AppUser => ({
  userId: 'u-1',
  roles: [],
  isAdmin: false,
  ...overrides,
}) as AppUser

const event = (allowedRoles: string[]) => ({ allowed_roles: allowedRoles })

describe('isEventRelevantToUser', () => {
  it('superAdmin sees every event regardless of allowed_roles', () => {
    const user = baseUser({ isSuperAdmin: true, roles: [] })
    expect(isEventRelevantToUser(event(['adminDenomination']), user)).toBe(true)
    expect(isEventRelevantToUser(event(['leaderBacenta']), user)).toBe(true)
    expect(isEventRelevantToUser(event([]), user)).toBe(true)
  })

  it('matches when one of the user roles intersects allowed_roles', () => {
    const user = baseUser({ roles: ['leaderCouncil', 'fishers'] })
    expect(isEventRelevantToUser(event(['leaderCouncil']), user)).toBe(true)
  })

  it('matches when ANY role overlaps, even if others do not', () => {
    const user = baseUser({ roles: ['leaderBacenta', 'fishers', 'leaderStream'] })
    expect(isEventRelevantToUser(event(['leaderStream', 'adminCouncil']), user)).toBe(true)
  })

  it('hides admin-restricted events from non-admins', () => {
    const user = baseUser({ roles: ['leaderBacenta'] })
    expect(isEventRelevantToUser(event(['adminStream', 'adminCouncil']), user)).toBe(false)
  })

  it('shows pure-leader events to anyone (no admin roles in allowed_roles)', () => {
    const user = baseUser({ roles: ['fishers'] })
    expect(isEventRelevantToUser(event(['leaderBacenta', 'leaderCouncil']), user)).toBe(true)
  })

  it('handles an empty roles array on the user', () => {
    // No user roles + allowed_roles has admin → hidden.
    expect(isEventRelevantToUser(event(['adminStream']), baseUser())).toBe(false)
    // No user roles + allowed_roles has only leader roles → visible (rule 3).
    expect(isEventRelevantToUser(event(['leaderBacenta']), baseUser())).toBe(true)
  })

  it('handles an empty allowed_roles list', () => {
    // No restrictions → visible per rule 3 (no admin roles in the empty set).
    expect(isEventRelevantToUser(event([]), baseUser({ roles: ['fishers'] }))).toBe(true)
  })

  it('handles missing allowed_roles field on the event', () => {
    expect(isEventRelevantToUser({}, baseUser({ roles: ['fishers'] }))).toBe(true)
  })

  it('admin user sees admin-restricted event matching their admin role', () => {
    const user = baseUser({ roles: ['adminDenomination', 'fishers'], isAdmin: true })
    expect(isEventRelevantToUser(event(['adminDenomination']), user)).toBe(true)
  })

  it('admin user does NOT see admin-restricted event for a different scope', () => {
    // adminCouncil cannot see an adminDenomination-only event.
    const user = baseUser({ roles: ['adminCouncil'], isAdmin: true })
    expect(isEventRelevantToUser(event(['adminDenomination']), user)).toBe(false)
  })
})
