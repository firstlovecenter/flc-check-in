import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getSupabaseAccessToken,
  MINTED_TOKEN_STORAGE_KEY,
  __resetTokenExchangeForTests,
} from './supabaseTokenExchange'
import { decodeJWT } from './auth'

const T0 = new Date('2026-09-28T10:00:00Z').getTime()
const T0_SEC = T0 / 1000

function b64url(obj: unknown) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}

function flcToken(payload: Record<string, unknown>, sig = 'sig') {
  return `${b64url({ alg: 'HS256' })}.${b64url(payload)}.${sig}`
}

function installStorage() {
  const map = new Map<string, string>()
  const storage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)) },
    removeItem: (k: string) => { map.delete(k) },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    clear: () => map.clear(),
    get length() { return map.size },
  }
  vi.stubGlobal('window', { localStorage: storage })
  vi.stubGlobal('localStorage', storage)
  return storage
}

function mintedResponse(token = 'minted-1', expiresAt = T0_SEC + 3600) {
  return new Response(JSON.stringify({ access_token: token, expires_at: expiresAt }), { status: 200 })
}

let storage: ReturnType<typeof installStorage>
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  vi.spyOn(Math, 'random').mockReturnValue(0)
  storage = installStorage()
  fetchMock = vi.fn(async () => mintedResponse())
  vi.stubGlobal('fetch', fetchMock)
  __resetTokenExchangeForTests()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('getSupabaseAccessToken', () => {
  it('returns null without calling the function when logged out', async () => {
    expect(await getSupabaseAccessToken()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exchanges once, then serves the cached token', async () => {
    storage.setItem('accessToken', flcToken({ userId: 'u1' }))
    expect(await getSupabaseAccessToken()).toBe('minted-1')
    expect(await getSupabaseAccessToken()).toBe('minted-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('shares one request between concurrent callers', async () => {
    storage.setItem('accessToken', flcToken({ userId: 'u1' }))
    const results = await Promise.all(Array.from({ length: 20 }, () => getSupabaseAccessToken()))
    expect(new Set(results)).toEqual(new Set(['minted-1']))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reuses the persisted token after a reload', async () => {
    storage.setItem('accessToken', flcToken({ userId: 'u1' }))
    await getSupabaseAccessToken()
    __resetTokenExchangeForTests() // simulates a fresh page load
    expect(await getSupabaseAccessToken()).toBe('minted-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the token when the FLC session refreshes for the same user', async () => {
    storage.setItem('accessToken', flcToken({ userId: 'u1' }, 'first'))
    await getSupabaseAccessToken()
    storage.setItem('accessToken', flcToken({ userId: 'u1' }, 'rotated'))
    expect(await getSupabaseAccessToken()).toBe('minted-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('exchanges again when a different user signs in', async () => {
    storage.setItem('accessToken', flcToken({ userId: 'u1' }))
    await getSupabaseAccessToken()
    fetchMock.mockImplementationOnce(async () => mintedResponse('minted-u2'))
    storage.setItem('accessToken', flcToken({ userId: 'u2' }))
    expect(await getSupabaseAccessToken()).toBe('minted-u2')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('renews in the background near expiry without making the caller wait', async () => {
    storage.setItem('accessToken', flcToken({ userId: 'u1' }))
    await getSupabaseAccessToken()
    // Math.random = 0 → renewal starts 5 min before expiry.
    vi.setSystemTime(T0 + (3600 - 299) * 1000)
    let resolveRenewal!: (r: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { resolveRenewal = r }))

    expect(await getSupabaseAccessToken()).toBe('minted-1') // not blocked
    expect(fetchMock).toHaveBeenCalledTimes(2)

    resolveRenewal(mintedResponse('minted-2', T0_SEC + 2 * 3600))
    await vi.waitFor(async () => expect(await getSupabaseAccessToken()).toBe('minted-2'))
  })

  it('backs off after a failure instead of retrying on every request', async () => {
    storage.setItem('accessToken', flcToken({ userId: 'u1' }))
    fetchMock.mockImplementation(async () => new Response('{}', { status: 503 }))

    expect(await getSupabaseAccessToken()).toBeNull()
    expect(await getSupabaseAccessToken()).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Math.random = 0 → first backoff is 7.5s.
    vi.setSystemTime(T0 + 8_000)
    fetchMock.mockImplementation(async () => mintedResponse())
    expect(await getSupabaseAccessToken()).toBe('minted-1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry an FLC token the function rejected, but tries its replacement', async () => {
    storage.setItem('accessToken', flcToken({ userId: 'u1' }, 'bad'))
    fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 401 }))
    expect(await getSupabaseAccessToken()).toBeNull()
    expect(await getSupabaseAccessToken()).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    storage.setItem('accessToken', flcToken({ userId: 'u1' }, 'refreshed'))
    expect(await getSupabaseAccessToken()).toBe('minted-1')
  })

  it('drops the persisted token on logout', async () => {
    storage.setItem('accessToken', flcToken({ userId: 'u1' }))
    await getSupabaseAccessToken()
    storage.removeItem('accessToken')
    expect(await getSupabaseAccessToken()).toBeNull()
    expect(storage.getItem(MINTED_TOKEN_STORAGE_KEY)).toBeNull()
  })

  it('does not persist a token that arrives after logout', async () => {
    storage.setItem('accessToken', flcToken({ userId: 'u1' }))
    let resolve!: (r: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { resolve = r }))
    const pending = getSupabaseAccessToken()
    storage.removeItem('accessToken')
    resolve(mintedResponse())
    expect(await pending).toBeNull()
    expect(storage.getItem(MINTED_TOKEN_STORAGE_KEY)).toBeNull()
  })
})

describe('decodeJWT', () => {
  it('decodes base64url payloads with non-ASCII names', () => {
    const payload = { userId: 'u1', firstName: 'Kwame Adjéi', note: '??>>~~' }
    expect(decodeJWT(flcToken(payload))).toEqual(payload)
  })

  it('returns null for malformed tokens', () => {
    expect(decodeJWT('not-a-jwt')).toBeNull()
  })
})
