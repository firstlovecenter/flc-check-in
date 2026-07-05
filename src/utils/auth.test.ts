import { describe, it, expect, vi } from 'vitest'
import { mergeRoleLists, loginWithCredentials, refreshSession, enrichUser } from './auth'

vi.mock('./supabase', () => ({
  supabase: {
    rpc: async () => ({ data: false, error: null }),
  },
}))

vi.mock('./graphProfileSync', () => ({
  syncGraphProfileForUserBackground: () => {},
}))

const setGlobal = (key: string, value: unknown) => {
  Object.defineProperty(globalThis, key, {
    value,
    configurable: true,
    writable: true,
  })
}

function makeToken(payload: Record<string, unknown>) {
  const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64')
  return `header.${base64Payload}.sig`
}

function installMemoryStorage() {
  const store = new Map<string, string>()
  const storage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    clear: () => { store.clear() },
    get length() { return store.size },
  }
  setGlobal('localStorage', storage)
  setGlobal('sessionStorage', storage)
  return storage
}

function installWindow() {
  setGlobal('window', {
    location: { origin: 'http://localhost:3000' },
    localStorage: globalThis.localStorage,
  })
}

describe('mergeRoleLists', () => {
  it('returns an empty array for non-array inputs', () => {
    expect(mergeRoleLists(undefined, null, 'adminStream', 42, { roles: [] })).toEqual([])
  })

  it('merges roles from multiple sources without dropping any', () => {
    const jwtRoles = ['leaderCouncil', 'adminStream']
    const authResponseRoles = ['adminStream', 'arrivalsAdminCouncil']
    const graphRoles = ['leaderBacenta']

    expect(mergeRoleLists(jwtRoles, authResponseRoles, graphRoles)).toEqual([
      'leaderCouncil',
      'adminStream',
      'arrivalsAdminCouncil',
      'leaderBacenta',
    ])
  })

  it('filters invalid/non-string role values', () => {
    const mixed = ['leaderCampus', '', null, undefined, 1, {}, 'adminCampus'] as unknown[]
    expect(mergeRoleLists(mixed)).toEqual(['leaderCampus', 'adminCampus'])
  })

  it('deduplicates repeated roles while preserving first-seen order', () => {
    expect(
      mergeRoleLists(
        ['adminCouncil', 'leaderGovernorship', 'adminCouncil'],
        ['leaderGovernorship', 'adminStream'],
      ),
    ).toEqual(['adminCouncil', 'leaderGovernorship', 'adminStream'])
  })
})

describe('auth role merge wiring', () => {
  it('loginWithCredentials merges JWT + auth-response roles into final user.roles', async () => {
    installMemoryStorage()
    installWindow()

    const jwtToken = makeToken({
      userId: 'u-1',
      exp: Math.floor(Date.now() / 1000) + 3600,
      roles: ['leaderCouncil', 'adminStream'],
    })

    setGlobal('fetch', async (url: string) => {
      if (url.endsWith('/login')) {
        return {
          ok: true,
          json: async () => ({
            tokens: { accessToken: jwtToken, refreshToken: 'rt-1' },
            user: { id: 'u-1', email: 'x@test.com', roles: ['adminStream', 'arrivalsAdminCouncil'] },
          }),
        } as Response
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    const user = await loginWithCredentials('x@test.com', 'pw')
    expect(user.roles).toEqual(['leaderCouncil', 'adminStream', 'arrivalsAdminCouncil'])
  })

  it('refreshSession merges refreshed JWT + refresh-response roles into final user.roles', async () => {
    installMemoryStorage()
    installWindow()
    globalThis.localStorage.setItem('refreshToken', 'rt-1')

    const refreshedToken = makeToken({
      userId: 'u-2',
      exp: Math.floor(Date.now() / 1000) + 3600,
      roles: ['leaderBacenta', 'adminGovernorship'],
    })

    setGlobal('fetch', async (url: string) => {
      if (url.endsWith('/refresh')) {
        return {
          ok: true,
          json: async () => ({
            tokens: { accessToken: refreshedToken, refreshToken: 'rt-2' },
            user: { id: 'u-2', roles: ['adminGovernorship', 'arrivalsAdminGovernorship'] },
          }),
        } as Response
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    const user = await refreshSession()
    expect(user?.roles).toEqual(['leaderBacenta', 'adminGovernorship', 'arrivalsAdminGovernorship'])
  })

  it('enrichUser preserves distinct admin/leader scopes from different hierarchies', () => {
    installMemoryStorage()
    installWindow()

    const user = enrichUser({
      roles: ['leaderStream', 'adminStream'],
      // Flat refs may come from persisted context and can represent one branch.
      stream: { id: 'flat-stream', name: 'Flat Stream' },
      // Explicit role edges can represent different branches and must both survive.
      churchScopes: {
        leadsStreamOf: { id: 'stream-leader-a', name: 'Leader Stream A' },
        isAdminForStreamOf: { id: 'stream-admin-b', name: 'Admin Stream B' },
      },
    })

    const streamContexts = (user.churchContexts || []).filter((c: any) => c.level === 'stream')
    expect(streamContexts.map((c: any) => `${c.source}:${c.id}`)).toContain('leader:stream-leader-a')
    expect(streamContexts.map((c: any) => `${c.source}:${c.id}`)).toContain('admin:stream-admin-b')
    // Once explicit role edges exist, flat fallback should not override them.
    expect(streamContexts.map((c: any) => c.id)).not.toContain('flat-stream')
  })
})
