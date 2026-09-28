// Client half of the flc-token-exchange edge function (see
// supabase/functions/flc-token-exchange/README.md).
//
// Wired into createClient via the `accessToken` option when
// VITE_USE_SUPABASE_TOKEN_EXCHANGE=1. supabase-js calls
// getSupabaseAccessToken() before EVERY request; returning null makes it fall
// back to the plain anon key, so the exchange failing (function not deployed,
// secrets missing, offline) degrades to exactly today's behavior.
//
// Built for the arrival rush (~2,000 leaders checking in at once):
//
//   • Only a request with NO usable token ever waits on the exchange. A valid
//     token is returned immediately, and renewal happens in the background.
//   • Renewal starts at a random point 5–15 min before expiry, so 2,000
//     clients who logged in together don't all re-exchange in the same second
//     an hour later — in the middle of the service.
//   • The minted token is persisted, so a PWA relaunch or reload doesn't
//     re-exchange. It is keyed to the FLC user, not the exact FLC token, so
//     the FLC session refreshing doesn't force a blocking re-exchange either.
//   • After a failure we back off (15s → 5 min, jittered) instead of retrying
//     on every request. Otherwise an unreachable function would add the full
//     timeout to every single Supabase call on every phone in the building.
//
// Must not import ./supabase (that module imports this one).

import { fetchWithTimeout } from './network'
import { decodeJWT } from './auth'

// Also cleared by logout() in auth.ts (literal duplicated there to avoid an
// import cycle — this module imports auth).
export const MINTED_TOKEN_STORAGE_KEY = 'flc:sbAccessToken'

const EXPIRY_SKEW_SEC = 60
const REFRESH_WINDOW_MIN_SEC = 5 * 60
const REFRESH_WINDOW_MAX_SEC = 15 * 60
const EXCHANGE_TIMEOUT_MS = 5_000
const BACKOFF_BASE_MS = 15_000
const BACKOFF_MAX_MS = 5 * 60_000

interface MintedToken {
  token: string
  /** Unix seconds. */
  exp: number
  /** FLC user the token was minted for. */
  uid: string
  /** Unix seconds — start a background renewal after this. */
  refreshAt: number
}

let _cached: MintedToken | null = null
let _inflight: Promise<string | null> | null = null
let _failures = 0
let _retryAfterMs = 0
// The FLC token the function answered 401 for. Retrying it is pointless; the
// FLC session refresh (RequireAuth) produces a new one, which we'll try.
let _rejectedFlcToken: string | null = null

const nowSec = () => Date.now() / 1000

function readFlcToken(): string | null {
  try {
    return typeof window !== 'undefined'
      ? window.localStorage?.getItem('accessToken') ?? null
      : null
  } catch {
    return null
  }
}

function flcUserId(flcToken: string): string | null {
  const payload = decodeJWT(flcToken)
  const uid = payload?.userId ?? payload?.sub
  return typeof uid === 'string' && uid ? uid : null
}

function loadPersisted(): MintedToken | null {
  try {
    const raw = window.localStorage?.getItem(MINTED_TOKEN_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed?.token !== 'string' || typeof parsed?.exp !== 'number'
        || typeof parsed?.uid !== 'string' || typeof parsed?.refreshAt !== 'number') {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function store(minted: MintedToken | null) {
  _cached = minted
  try {
    if (minted) window.localStorage?.setItem(MINTED_TOKEN_STORAGE_KEY, JSON.stringify(minted))
    else window.localStorage?.removeItem(MINTED_TOKEN_STORAGE_KEY)
  } catch { /* private mode / quota — memory cache still works */ }
}

function pickRefreshAt(exp: number): number {
  const lifetime = exp - nowSec()
  const lead = REFRESH_WINDOW_MIN_SEC
    + Math.random() * (REFRESH_WINDOW_MAX_SEC - REFRESH_WINDOW_MIN_SEC)
  // Short-lived tokens: renew somewhere in the second half of their life.
  return exp - Math.min(lead, lifetime / 2)
}

function noteFailure() {
  _failures += 1
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (_failures - 1))
  _retryAfterMs = Date.now() + base * (0.5 + Math.random() * 0.5)
}

export async function getSupabaseAccessToken(): Promise<string | null> {
  const flcToken = readFlcToken()
  if (!flcToken) {
    if (_cached || loadPersisted()) store(null) // logged out → drop, fall back to anon
    return null
  }
  const uid = flcUserId(flcToken)
  if (!uid) return null

  const cached = _cached ?? loadPersisted()
  if (cached && cached.uid === uid && cached.exp - EXPIRY_SKEW_SEC > nowSec()) {
    _cached = cached
    if (nowSec() >= cached.refreshAt) void startExchange(flcToken, uid)
    return cached.token
  }
  if (cached && cached.uid !== uid) store(null) // different user signed in

  // No usable token: this request has to wait — unless we're backing off.
  return startExchange(flcToken, uid)
}

function startExchange(flcToken: string, uid: string): Promise<string | null> {
  if (_inflight) return _inflight
  if (flcToken === _rejectedFlcToken || Date.now() < _retryAfterMs) {
    return Promise.resolve(null)
  }
  _inflight = exchange(flcToken, uid).finally(() => { _inflight = null })
  return _inflight
}

async function exchange(flcToken: string, uid: string): Promise<string | null> {
  try {
    const base = import.meta.env.VITE_SUPABASE_URL
    const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
    const res = await fetchWithTimeout(`${base}/functions/v1/flc-token-exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
      },
      body: JSON.stringify({ token: flcToken }),
    }, { timeoutMs: EXCHANGE_TIMEOUT_MS, retries: 0 })

    if (res.status === 401) {
      _rejectedFlcToken = flcToken
      return null
    }
    if (!res.ok) {
      noteFailure()
      return null
    }
    const data = await res.json().catch(() => null)
    const exp = Number(data?.expires_at)
    if (typeof data?.access_token !== 'string' || !Number.isFinite(exp)) {
      noteFailure()
      return null
    }
    _failures = 0
    _retryAfterMs = 0
    _rejectedFlcToken = null
    // The user may have logged out while the request was in flight.
    if (readFlcToken() == null) return null
    store({ token: data.access_token, exp, uid, refreshAt: pickRefreshAt(exp) })
    return data.access_token
  } catch {
    noteFailure()
    return null
  }
}

/** Test-only: reset module state between cases. */
export function __resetTokenExchangeForTests() {
  _cached = null
  _inflight = null
  _failures = 0
  _retryAfterMs = 0
  _rejectedFlcToken = null
}
