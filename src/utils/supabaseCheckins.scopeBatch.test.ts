import { beforeEach, describe, expect, it, vi } from 'vitest'

// listEventsForAdminScopes now resolves visibility in Postgres
// (list_events_for_scopes, migration 047): every church of every event plus
// roster overlap. These tests pin the client contract — one RPC, the scopes and
// statuses passed through, no client-side expansion or OR-filter batching.

const rpcMock = vi.fn()
const fromMock = vi.fn()
const getChildChurchesMock = vi.fn()

vi.mock('./membersApi', () => ({
  childScopeLevel: vi.fn(() => null),
  getChildChurches: (...args: any[]) => getChildChurchesMock(...args),
  getChurchAncestors: vi.fn(async () => []),
}))

vi.mock('./supabase', () => ({
  supabase: {
    rpc: (...args: any[]) => rpcMock(...args),
    from: (...args: any[]) => fromMock(...args),
  },
}))

import { listEventsForAdminScopes } from './supabaseCheckins'

function row(id: string, scopeChurchName: string) {
  return {
    id, name: id, event_type: null, status: 'ACTIVE',
    scope_level: 'oversight', scope_church_id: 'o-1', scope_church_name: scopeChurchName,
    venue_name: null, starts_at: '2027-01-01T00:00:00Z', ends_at: '2027-01-02T00:00:00Z',
    grace_period_min: 15, auto_checkout_min: 0, allowed_check_in_methods: ['QR'], allowed_roles: [],
    geofence_type: 'circle', geofence_center_lat: null, geofence_center_lng: null, geofence_radius_m: null,
    created_by_id: 'u-1', created_by_name: 'Tester', created_at: '2027-01-01T00:00:00Z',
    series_id: null, series_index: null, is_public: true, descendants_resolved: true,
  }
}

const regularUser = { isSuperAdmin: false, isSuperViewer: false } as any

describe('listEventsForAdminScopes (server-side visibility)', () => {
  beforeEach(() => {
    rpcMock.mockReset()
    fromMock.mockReset()
    getChildChurchesMock.mockReset()
    rpcMock.mockResolvedValue({ data: [row('camp', 'Outside Accra + Accra')], error: null })
  })

  it('makes ONE list_events_for_scopes call with the scopes and statuses', async () => {
    const scopes = Array.from({ length: 85 }, (_, i) => ({ level: 'stream', id: `s-${i}` }))
    const rows = await listEventsForAdminScopes(scopes, { statuses: ['ENDED'], user: regularUser })

    expect(rpcMock).toHaveBeenCalledTimes(1)
    const [fn, params] = rpcMock.mock.calls[0]
    expect(fn).toBe('list_events_for_scopes')
    expect(params.p_scopes).toHaveLength(85)
    expect(params.p_scopes[0]).toEqual({ level: 'stream', id: 's-0' })
    expect(params.p_statuses).toEqual(['ENDED'])
    expect(rows.map((r) => r.id)).toEqual(['camp'])
  })

  it('does no client-side tree expansion or table scans', async () => {
    await listEventsForAdminScopes([{ level: 'stream', id: 'stream-A' }], { user: regularUser })
    expect(getChildChurchesMock).not.toHaveBeenCalled()
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('returns nothing without scopes and never calls the server', async () => {
    expect(await listEventsForAdminScopes([], { user: regularUser })).toEqual([])
    expect(rpcMock).not.toHaveBeenCalled()
  })
})
