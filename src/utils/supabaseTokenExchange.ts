// Client half of the flc-token-exchange edge function (see
// supabase/functions/flc-token-exchange/README.md).
//
// Wired into createClient via the `accessToken` option when
// VITE_USE_SUPABASE_TOKEN_EXCHANGE=1. supabase-js calls
// getSupabaseAccessToken() before each request; returning null makes it fall
// back to the plain anon key, so the exchange failing (function not deployed,
// secrets missing, offline) degrades to exactly today's behavior.
//
// Must not import ./supabase (that module imports this one).

import { fetchWithTimeout } from './network'

let _cached: { token: string; exp: number; flcToken: string } | null = null
let _inflight: Promise<string | null> | null = null

const EXPIRY_SKEW_SEC = 60

export async function getSupabaseAccessToken(): Promise<string | null> {
  const flcToken = typeof window !== 'undefined'
    ? window.localStorage?.getItem('accessToken')
    : null
  if (!flcToken) {
    _cached = null // logged out → drop any minted token, fall back to anon
    return null
  }

  if (
    _cached &&
    _cached.flcToken === flcToken &&
    _cached.exp - EXPIRY_SKEW_SEC > Date.now() / 1000
  ) {
    return _cached.token
  }

  if (!_inflight) {
    _inflight = exchange(flcToken).finally(() => { _inflight = null })
  }
  return _inflight
}

async function exchange(flcToken: string): Promise<string | null> {
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
    }, { timeoutMs: 8_000 })
    if (!res.ok) return null
    const data = await res.json().catch(() => null)
    if (!data?.access_token) return null
    _cached = { token: data.access_token, exp: data.expires_at ?? 0, flcToken }
    return _cached.token
  } catch {
    return null
  }
}
