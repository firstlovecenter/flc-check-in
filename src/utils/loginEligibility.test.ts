import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUser } from '../types/app'

const mocks = vi.hoisted(() => ({
  clearResolveCurrentMemberCache: vi.fn(),
  resolveCurrentMember: vi.fn(),
  persistResolvedGraphProfileForUser: vi.fn(),
  isLeaderOrAdmin: vi.fn(),
}))

vi.mock('./graphProfileSync', () => ({
  persistResolvedGraphProfileForUser: mocks.persistResolvedGraphProfileForUser,
}))

vi.mock('./membersApi', () => ({
  clearResolveCurrentMemberCache: mocks.clearResolveCurrentMemberCache,
  isLeaderOrAdmin: mocks.isLeaderOrAdmin,
  resolveCurrentMember: mocks.resolveCurrentMember,
}))

import { hasLeaderOrAdminRole, verifyLoginEligibility } from './loginEligibility'

function makeUser(overrides: Partial<AppUser> = {}): AppUser {
  return {
    userId: 'user-1',
    email: 'leader@example.com',
    roles: [],
    isAdmin: false,
    ...overrides,
  }
}

describe('verifyLoginEligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('allows a superadmin without calling the member graph', async () => {
    await expect(
      verifyLoginEligibility(makeUser({ isSuperAdmin: true })),
    ).resolves.toEqual({ eligible: true, source: 'superadmin' })

    expect(mocks.resolveCurrentMember).not.toHaveBeenCalled()
  })

  it('allows a graph member with leadership and persists the resolved profile', async () => {
    const user = makeUser({ roles: ['leaderCouncil'] })
    const member = { id: 'member-1', leadsCouncil: [{ id: 'council-1' }] }
    mocks.resolveCurrentMember.mockResolvedValue(member)
    mocks.persistResolvedGraphProfileForUser.mockResolvedValue({ member, synced: true })
    mocks.isLeaderOrAdmin.mockReturnValue(true)

    await expect(verifyLoginEligibility(user)).resolves.toEqual({
      eligible: true,
      source: 'member-graph',
    })
    expect(mocks.resolveCurrentMember).toHaveBeenCalledOnce()
    expect(mocks.clearResolveCurrentMemberCache).toHaveBeenCalledWith(user)
    expect(mocks.resolveCurrentMember).toHaveBeenCalledWith(user)
    expect(mocks.isLeaderOrAdmin).toHaveBeenCalledWith(member)
    expect(mocks.persistResolvedGraphProfileForUser).toHaveBeenCalledWith(user, member)
  })

  it('rejects a graph member without leadership', async () => {
    const user = makeUser()
    const member = { id: 'member-1' }
    mocks.resolveCurrentMember.mockResolvedValue(member)
    mocks.isLeaderOrAdmin.mockReturnValue(false)

    await expect(verifyLoginEligibility(user)).resolves.toEqual({
      eligible: false,
      source: 'member-graph',
    })
    expect(mocks.persistResolvedGraphProfileForUser).not.toHaveBeenCalled()
  })

  it('preserves degraded access on graph failure only for a fresh auth leader role', async () => {
    mocks.resolveCurrentMember.mockRejectedValue(new Error('graph unavailable'))

    await expect(
      verifyLoginEligibility(makeUser({ roles: ['leaderCouncil'] })),
    ).resolves.toEqual({ eligible: true, source: 'auth-degraded' })
  })

  it('propagates graph failure when auth roles do not grant access', async () => {
    const graphError = new Error('graph unavailable')
    mocks.resolveCurrentMember.mockRejectedValue(graphError)

    await expect(verifyLoginEligibility(makeUser({ roles: ['member'] })))
      .rejects.toBe(graphError)
  })

  it('does not let profile persistence failure change a graph authorization decision', async () => {
    const user = makeUser({ roles: ['leaderCouncil'] })
    const member = { id: 'member-1', leadsCouncil: [{ id: 'council-1' }] }
    mocks.resolveCurrentMember.mockResolvedValue(member)
    mocks.isLeaderOrAdmin.mockReturnValue(true)
    mocks.persistResolvedGraphProfileForUser.mockRejectedValue(new Error('supabase unavailable'))

    await expect(verifyLoginEligibility(user)).resolves.toEqual({
      eligible: true,
      source: 'member-graph',
    })
  })
})

describe('hasLeaderOrAdminRole', () => {
  it('accepts canonical leader/admin roles and rejects unrelated roles', () => {
    expect(hasLeaderOrAdminRole(['leaderBacenta'])).toBe(true)
    expect(hasLeaderOrAdminRole(['adminDenomination'])).toBe(true)
    expect(hasLeaderOrAdminRole(['member', 'arrivalsAdminCouncil'])).toBe(false)
  })
})
