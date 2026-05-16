// Tests for the centralised user-scope resolver.
//
// What this protects against
// --------------------------
// Before utils/userScope.ts existed, every screen reinvented the same fallback
// chain inline and they drifted, producing "leader sees no events" symptoms
// that bit us four times in production. These tests pin the resolution order
// AND the multi-ref behaviour (admin + leader edges coexisting) so any future
// change is intentional, not accidental.

import { describe, it, expect } from 'vitest'
import {
  getUserChurchRef,
  getUserChurchId,
  getUserChurchRefs,
  getUserChurchRefsAt,
  isUserAdminAt,
  getUserAdminScopesFromJwt,
} from './userScope'
import type { AppUser } from '../types/app'

/** Minimal valid AppUser. Tests spread additional fields on top. */
const baseUser = (overrides: Partial<AppUser> = {}): AppUser => ({
  userId: 'u-1',
  roles: [],
  isAdmin: false,
  ...overrides,
}) as AppUser

describe('getUserChurchRef — canonical (preferred) ref', () => {
  it('returns null when user is null/undefined', () => {
    expect(getUserChurchRef(null, 'council')).toBeNull()
    expect(getUserChurchRef(undefined, 'council')).toBeNull()
  })

  it('returns null when no source has a value at the requested level', () => {
    expect(getUserChurchRef(baseUser(), 'council')).toBeNull()
  })

  it('rung 1: flat top-level ref wins over all other sources', () => {
    const user = baseUser({
      council: { id: 'top-1', name: 'Top Council' },
      activeChurch: { id: 'active-1', name: 'Active Council', level: 'council' },
      churchScopes: {
        isAdminForCouncilOf: { id: 'admin-1', name: 'Admin Council' },
        leadsCouncilOf:      { id: 'leads-1', name: 'Leads Council' },
      },
    })
    expect(getUserChurchRef(user, 'council')).toEqual({
      level: 'council', id: 'top-1', name: 'Top Council', source: 'flat',
    })
  })

  it('rung 2: activeChurch wins when matching level and no flat ref', () => {
    const user = baseUser({
      activeChurch: { id: 'active-1', name: 'Active Council', level: 'council' },
      churchScopes: { isAdminForCouncilOf: { id: 'admin-1' } },
    })
    const ref = getUserChurchRef(user, 'council')
    expect(ref?.id).toBe('active-1')
    expect(ref?.source).toBe('active')
  })

  it('rung 2: activeChurch is ignored when its level does not match', () => {
    const user = baseUser({
      activeChurch: { id: 'active-stream', name: 'Stream', level: 'stream' },
      churchScopes: { isAdminForCouncilOf: { id: 'admin-1' } },
    })
    const ref = getUserChurchRef(user, 'council')
    expect(ref?.id).toBe('admin-1')
    expect(ref?.source).toBe('admin')
  })

  it('rung 3: churchScopes admin edge wins over leader edge for the canonical pick', () => {
    const user = baseUser({
      churchScopes: {
        isAdminForCouncilOf: { id: 'admin-1', name: 'Admin Council' },
        leadsCouncilOf:      { id: 'leads-1', name: 'Leads Council' },
      },
    })
    const ref = getUserChurchRef(user, 'council')
    expect(ref?.id).toBe('admin-1')
    expect(ref?.source).toBe('admin')
  })

  it('rung 4: leader edge is used when admin edge is absent', () => {
    const user = baseUser({
      churchScopes: { leadsCouncilOf: { id: 'leads-1', name: 'Leads Council' } },
    })
    const ref = getUserChurchRef(user, 'council')
    expect(ref?.id).toBe('leads-1')
    expect(ref?.source).toBe('leader')
  })

  it('rejects scope refs whose id is missing/non-string', () => {
    const user = baseUser({
      churchScopes: {
        // shape can occur when graph returns a partial null
        isAdminForCouncilOf: { id: undefined as any },
        leadsCouncilOf: { id: 'leads-1' },
      },
    })
    expect(getUserChurchRef(user, 'council')?.id).toBe('leads-1')
  })

  it('handles missing churchScopes block entirely', () => {
    const user = baseUser({ council: { id: 'top-1', name: 'C' } })
    expect(getUserChurchRef(user, 'council')?.id).toBe('top-1')
  })

  it('handles null/undefined entries inside churchScopes', () => {
    const user = baseUser({
      churchScopes: {
        isAdminForCouncilOf: null,
        leadsCouncilOf: undefined,
      },
    })
    expect(getUserChurchRef(user, 'council')).toBeNull()
  })

  it('does not bleed across levels — a stream ref does not satisfy a council lookup', () => {
    const user = baseUser({ stream: { id: 's-1' } })
    expect(getUserChurchRef(user, 'council')).toBeNull()
    expect(getUserChurchRef(user, 'stream')?.id).toBe('s-1')
  })
})

describe('getUserChurchRefsAt — multiple refs per level', () => {
  it('returns admin AND leader edges when they point at different churches', () => {
    // Models streamadmin@test.com:
    //   leadsStreamOf:      { id: 'leads-1', name: 'ToClose 2' }
    //   isAdminForStreamOf: { id: 'admin-1', name: 'Test Stream' }
    const user = baseUser({
      churchScopes: {
        leadsStreamOf:      { id: 'leads-1', name: 'ToClose 2' },
        isAdminForStreamOf: { id: 'admin-1', name: 'Test Stream' },
      },
    })
    const refs = getUserChurchRefsAt(user, 'stream')
    expect(refs).toHaveLength(2)
    expect(refs.find((r) => r.id === 'admin-1')?.source).toBe('admin')
    expect(refs.find((r) => r.id === 'leads-1')?.source).toBe('leader')
  })

  it('dedupes by id when admin and leader edges point at the same church', () => {
    const user = baseUser({
      churchScopes: {
        leadsStreamOf:      { id: 'same-1', name: 'Same' },
        isAdminForStreamOf: { id: 'same-1', name: 'Same' },
      },
    })
    const refs = getUserChurchRefsAt(user, 'stream')
    expect(refs).toHaveLength(1)
    // Admin runs first in the source order, so admin wins the dedupe.
    expect(refs[0].source).toBe('admin')
  })

  it('flat ref keeps its source tag even when it shadows admin/leader edges', () => {
    const user = baseUser({
      council: { id: 'flat-1', name: 'Flat Council' },
      churchScopes: {
        isAdminForCouncilOf: { id: 'admin-1', name: 'Admin Council' },
        leadsCouncilOf:      { id: 'leads-1', name: 'Leads Council' },
      },
    })
    const refs = getUserChurchRefsAt(user, 'council')
    // All three distinct IDs come through, in order.
    expect(refs.map((r) => `${r.source}:${r.id}`)).toEqual([
      'flat:flat-1',
      'admin:admin-1',
      'leader:leads-1',
    ])
  })

  it('returns empty array for null user / no matching level', () => {
    expect(getUserChurchRefsAt(null, 'council')).toEqual([])
    expect(getUserChurchRefsAt(baseUser(), 'council')).toEqual([])
  })
})

describe('getUserChurchId', () => {
  it('returns the id from the resolved canonical ref', () => {
    const user = baseUser({ denomination: { id: 'd-1', name: 'D' } })
    expect(getUserChurchId(user, 'denomination')).toBe('d-1')
  })

  it('returns null when no source resolves', () => {
    expect(getUserChurchId(baseUser(), 'denomination')).toBeNull()
  })
})

describe('getUserChurchRefs — full set across all levels', () => {
  it('returns an empty array for null user', () => {
    expect(getUserChurchRefs(null)).toEqual([])
  })

  it('returns refs in SCOPE_LEVELS order (lowest -> highest)', () => {
    const user = baseUser({
      denomination: { id: 'd-1' },
      bacenta:      { id: 'b-1' },
      campus:       { id: 'c-1' },
    })
    const refs = getUserChurchRefs(user)
    expect(refs.map((r) => r.level)).toEqual(['bacenta', 'campus', 'denomination'])
  })

  it('mixes sources across levels — bacenta from flat, council from JWT', () => {
    const user = baseUser({
      bacenta: { id: 'b-1' },
      churchScopes: { leadsCouncilOf: { id: 'c-1' } },
    })
    const refs = getUserChurchRefs(user)
    expect(refs).toHaveLength(2)
    expect(refs.find((r) => r.level === 'bacenta')).toMatchObject({ id: 'b-1', source: 'flat' })
    expect(refs.find((r) => r.level === 'council')).toMatchObject({ id: 'c-1', source: 'leader' })
  })

  it('emits BOTH admin and leader churches at the same level (streamadmin scenario)', () => {
    // The bug this prevents: streamadmin@test.com has events scoped to
    // 'ToClose 2' (leader edge) AND 'Test Stream' (admin edge). The PostgREST
    // filter must include both ids so the user sees events at either church.
    const user = baseUser({
      churchScopes: {
        leadsStreamOf:      { id: 'leads-1', name: 'ToClose 2' },
        isAdminForStreamOf: { id: 'admin-1', name: 'Test Stream' },
      },
    })
    const streamRefs = getUserChurchRefs(user).filter((r) => r.level === 'stream')
    expect(streamRefs.map((r) => r.id).sort()).toEqual(['admin-1', 'leads-1'])
  })

  it('drops levels that have no source', () => {
    const user = baseUser({ stream: { id: 's-1' } })
    const refs = getUserChurchRefs(user)
    expect(refs).toHaveLength(1)
    expect(refs[0]).toEqual({ level: 'stream', id: 's-1', name: undefined, source: 'flat' })
  })
})

describe('isUserAdminAt', () => {
  it('false for null user', () => {
    expect(isUserAdminAt(null, 'denomination')).toBe(false)
  })

  it('true for superAdmin regardless of edges', () => {
    const user = baseUser({ isSuperAdmin: true })
    expect(isUserAdminAt(user, 'denomination')).toBe(true)
    expect(isUserAdminAt(user, 'bacenta')).toBe(true)
  })

  it('true when isAdminFor<L>Of is present in JWT', () => {
    const user = baseUser({ churchScopes: { isAdminForStreamOf: { id: 's-1' } } })
    expect(isUserAdminAt(user, 'stream')).toBe(true)
  })

  it('false when only the leader edge exists', () => {
    const user = baseUser({ churchScopes: { leadsStreamOf: { id: 's-1' } } })
    expect(isUserAdminAt(user, 'stream')).toBe(false)
  })

  it('false when the admin edge is at a different level than asked', () => {
    const user = baseUser({ churchScopes: { isAdminForCouncilOf: { id: 'c-1' } } })
    expect(isUserAdminAt(user, 'stream')).toBe(false)
    expect(isUserAdminAt(user, 'council')).toBe(true)
  })
})

describe('getUserAdminScopesFromJwt', () => {
  it('returns [] when there are no admin edges', () => {
    expect(getUserAdminScopesFromJwt(baseUser())).toEqual([])
    expect(getUserAdminScopesFromJwt(baseUser({ churchScopes: { leadsBacentaOf: { id: 'b-1' } } }))).toEqual([])
  })

  it('returns admin scopes sorted highest-level first', () => {
    const user = baseUser({
      churchScopes: {
        isAdminForCouncilOf:      { id: 'c-1', name: 'C' },
        isAdminForDenominationOf: { id: 'd-1', name: 'D' },
        isAdminForStreamOf:       { id: 's-1', name: 'S' },
      },
    })
    const out = getUserAdminScopesFromJwt(user)
    expect(out.map((r) => r.level)).toEqual(['denomination', 'stream', 'council'])
  })

  it('all returned refs are tagged source: admin', () => {
    const user = baseUser({
      churchScopes: { isAdminForCouncilOf: { id: 'c-1', name: 'C' } },
    })
    expect(getUserAdminScopesFromJwt(user)[0].source).toBe('admin')
  })

  it('ignores leader-edge keys — only isAdminFor* counts', () => {
    const user = baseUser({
      churchScopes: {
        leadsCouncilOf:    { id: 'lc-1' },
        leadsDenominationOf: { id: 'ld-1' },
      },
    })
    expect(getUserAdminScopesFromJwt(user)).toEqual([])
  })

  it('never emits a bacenta admin scope (no admin edge at bacenta)', () => {
    const user = baseUser({
      churchScopes: {
        // @ts-expect-error — intentional invalid shape
        isAdminForBacentaOf: { id: 'b-1', name: 'B' },
        isAdminForCouncilOf: { id: 'c-1', name: 'C' },
      },
    })
    const levels = getUserAdminScopesFromJwt(user).map((r) => r.level)
    expect(levels).not.toContain('bacenta')
    expect(levels).toEqual(['council'])
  })
})
