// Tests for the post-fetch event-relevance gate.
//
// Design: event visibility is determined entirely by the PostgREST scope filter
// (buildScopeOrFilter). If the DB returned an event, the user is structurally
// scoped for it and it is relevant. allowed_roles controls check-in eligibility
// only — it has no bearing on whether the user can *see* the event.
//
// isEventRelevantToUser is therefore a pass-through that always returns true.
// It is kept as an explicit hook so that future per-event visibility rules
// (e.g. draft events, private flags) have a clear place to live.

import { describe, it, expect } from 'vitest'
import { isEventRelevantToUser } from './supabaseCheckins'
import type { AppUser } from '../types/app'

const baseUser = (overrides: Partial<AppUser> = {}): AppUser => ({
  userId: 'u-1',
  roles: [],
  isAdmin: false,
  ...overrides,
}) as AppUser

const event = (allowedRoles: string[], scopeLevel?: string) => ({
  allowed_roles: allowedRoles,
  ...(scopeLevel ? { scope_level: scopeLevel } : {}),
})

describe('isEventRelevantToUser', () => {
  it('returns true for any user — scope filter already narrowed the result set', () => {
    expect(isEventRelevantToUser(event([]), baseUser())).toBe(true)
    expect(isEventRelevantToUser(event(['leaderBacenta']), baseUser({ roles: ['fishers'] }))).toBe(true)
    expect(isEventRelevantToUser(event(['adminDenomination']), baseUser({ roles: ['adminStream'] }))).toBe(true)
    expect(isEventRelevantToUser(event(['adminStream', 'adminCouncil']), baseUser({ roles: ['leaderBacenta'] }))).toBe(true)
  })

  it('returns true for superAdmins', () => {
    expect(isEventRelevantToUser(event(['adminDenomination']), baseUser({ isSuperAdmin: true }))).toBe(true)
  })

  it('returns true for a denomination admin viewing a denomination-scoped event', () => {
    const user = baseUser({ roles: ['adminDenomination'], isAdmin: true })
    expect(isEventRelevantToUser(event(['leaderStream', 'adminOversight'], 'denomination'), user)).toBe(true)
  })

  it('handles missing allowed_roles and scope_level gracefully', () => {
    expect(isEventRelevantToUser({}, baseUser())).toBe(true)
  })
})
