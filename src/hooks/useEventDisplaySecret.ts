// Fetches an event's rotating-code secret on demand, for the screens that
// genuinely display a PIN or QR code.
//
// The secret used to ride along in every event listing, which meant any client
// that could see an event could generate a valid code for it from anywhere.
// Rotating codes only prove presence if the secret stays server-side, so it is
// now excluded from every column projection and requested explicitly here.
// See migration 038.
//
// Cached per event for the session: the secret does not change for the life of
// an event, and the PIN display re-derives a new code every 15 seconds from
// the same value — refetching it on each tick would be pointless traffic.

import { useEffect, useState } from 'react'
import { getEventDisplaySecret } from '../utils/supabaseCheckins'

const cache = new Map<string, string | null>()
const inflight = new Map<string, Promise<string | null>>()

function loadSecret(eventId: string): Promise<string | null> {
  if (cache.has(eventId)) return Promise.resolve(cache.get(eventId) ?? null)
  const existing = inflight.get(eventId)
  if (existing) return existing

  const promise = getEventDisplaySecret(eventId)
    .then((secret) => {
      cache.set(eventId, secret)
      return secret
    })
    .catch(() => null)
    .finally(() => { inflight.delete(eventId) })

  inflight.set(eventId, promise)
  return promise
}

/** Returns the hex secret, or null while loading / on failure.
 *  Callers should render a spinner on null rather than an error — a missing
 *  secret means "not yet", and the display screens poll anyway. */
export function useEventDisplaySecret(eventId: string | undefined, enabled = true): string | null {
  const [secret, setSecret] = useState<string | null>(() =>
    eventId ? cache.get(eventId) ?? null : null,
  )

  useEffect(() => {
    if (!eventId || !enabled) return
    let cancelled = false
    void loadSecret(eventId).then((value) => {
      if (!cancelled) setSecret(value)
    })
    return () => { cancelled = true }
  }, [eventId, enabled])

  return secret
}
