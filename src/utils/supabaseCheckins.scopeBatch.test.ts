import { beforeEach, describe, expect, it, vi } from 'vitest'

const capturedOrFilters: string[] = []
const fromMock = vi.fn()

const childScopeLevelMock = vi.fn((level: string) => {
  if (level === 'stream') return 'council'
  return null
})

const getChildChurchesMock = vi.fn(async ({ level, id }: { level: string; id: string }) => {
  if (level === 'stream') return [{ id: `${id}-c1`, name: `${id} Council` }]
  return []
})

vi.mock('./membersApi', () => ({
  childScopeLevel: (level: string) => childScopeLevelMock(level),
  getChildChurches: ({ level, id }: { level: string; id: string }) => getChildChurchesMock({ level, id }),
  getChurchAncestors: vi.fn(async () => []),
}))

function makeEventRow(id: string, scopeLevel: string, scopeChurchId: string, startsAt: string) {
  return {
    id,
    name: id,
    event_type: null,
    status: 'ACTIVE',
    scope_level: scopeLevel,
    scope_church_id: scopeChurchId,
    scope_church_name: scopeChurchId,
    venue_name: null,
    starts_at: startsAt,
    ends_at: '2027-12-31T00:00:00Z',
    grace_period_min: 15,
    auto_checkout_min: 0,
    allowed_check_in_methods: ['QR'],
    allowed_roles: [],
    geofence_type: 'circle',
    geofence_center_lat: null,
    geofence_center_lng: null,
    geofence_radius_m: null,
    qr_secret: '\\xabc',
    created_by_id: 'u-1',
    created_by_name: 'Tester',
    created_at: '2027-01-01T00:00:00Z',
    series_id: null,
    series_index: null,
    is_public: true,
  }
}

vi.mock('./supabase', () => ({
  supabase: {
    from: (...args: any[]) => fromMock(...args),
  },
}))

import { listEventsForAdminScopes } from './supabaseCheckins'

function installFromMock() {
  fromMock.mockImplementation(() => {
    let orFilter = ''
    return {
      select() { return this },
      or(filter: string) { orFilter = filter; return this },
      in() { return this },
      neq() { return this },
      order: async () => {
        capturedOrFilters.push(orFilter)
        const ids = [...orFilter.matchAll(/scope_church_id\.eq\.([^,)]+)/g)].map((m) => m[1])
        const rows = ids.map((id, idx) => makeEventRow(`evt-${id}`, 'stream', id, `2027-01-${String((idx % 9) + 1).padStart(2, '0')}T00:00:00Z`))
        // Returned on every batch; listEventsForAdminScopes must dedupe it.
        rows.push(makeEventRow('common', 'stream', 'common', '2027-12-31T00:00:00Z'))
        return { data: rows, error: null }
      },
    }
  })
}

describe('listEventsForAdminScopes batching and descendant expansion', () => {
  beforeEach(() => {
    capturedOrFilters.length = 0
    fromMock.mockReset()
    childScopeLevelMock.mockClear()
    getChildChurchesMock.mockClear()
    installFromMock()
  })

  it('batches large expanded scope filters and dedupes merged rows', async () => {
    const scopes = Array.from({ length: 85 }, (_, i) => ({ level: 'stream', id: `s-${i}` }))

    const rows = await listEventsForAdminScopes(scopes, {
      user: { isSuperAdmin: false, isSuperViewer: false } as any,
    })

    // 85 streams + 85 child councils = 170 scope pairs, batched by 40 => 5 calls.
    expect(capturedOrFilters.length).toBe(5)
    expect(rows.filter((r) => r.id === 'common')).toHaveLength(1)
  })

  it('expands selected parent scopes to include descendant scope pairs in SQL filters', async () => {
    await listEventsForAdminScopes(
      [{ level: 'stream', id: 'stream-A' }],
      { user: { isSuperAdmin: false, isSuperViewer: false } as any },
    )

    const joined = capturedOrFilters.join(',')
    expect(joined).toContain('scope_level.eq.stream')
    expect(joined).toContain('scope_church_id.eq.stream-A')
    expect(joined).toContain('scope_level.eq.council')
    expect(joined).toContain('scope_church_id.eq.stream-A-c1')
  })
})
