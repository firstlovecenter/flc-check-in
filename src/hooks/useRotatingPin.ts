// Derives the event's current 15-second rotating check-in PIN and the seconds
// until it next rotates. The derivation mirrors the server's bucketed OTP (see
// the submit_checkin RPC), so the displayed value is always one the server will
// accept. Shared by the public /events display and the in-app check-in page.

import { useEffect, useState } from 'react'
import { generateRotatingPin, currentBucket } from '../utils/checkinsCrypto'

const PIN_WINDOW_SEC = 15

export function useRotatingPin(
  event: { id: string; qr_secret_hex?: string | null } | null | undefined,
  enabled = true,
): { pin: string | null; secsLeft: number } {
  const [pin, setPin] = useState<string | null>(null)
  const [secsLeft, setSecsLeft] = useState(() => PIN_WINDOW_SEC - (Math.floor(Date.now() / 1000) % PIN_WINDOW_SEC))
  // The active 15-second bucket. Regenerating off this (rather than off an
  // exact boundary-second equality) means a dropped interval tick can't leave
  // the PIN stale — we resync to whatever bucket the wall clock is now in.
  const [bucket, setBucket] = useState(() => currentBucket(Date.now(), PIN_WINDOW_SEC))

  const secretHex = event?.qr_secret_hex
  const eventId = event?.id

  // Generate the PIN only when enabled (and we have a secret) — but keep the
  // countdown below running regardless, since callers also use secsLeft for a
  // QR-only rotation display.
  useEffect(() => {
    if (!enabled || !secretHex || !eventId) { setPin(null); return }
    let cancelled = false
    ;(async () => {
      const p = await generateRotatingPin({ secretHex, eventId, bucket })
      if (!cancelled) setPin(p)
    })()
    return () => { cancelled = true }
  }, [secretHex, eventId, enabled, bucket])

  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now()
      setSecsLeft(PIN_WINDOW_SEC - (Math.floor(now / 1000) % PIN_WINDOW_SEC))
      const next = currentBucket(now, PIN_WINDOW_SEC)
      setBucket((b) => (next !== b ? next : b))
    }, 1000)
    return () => clearInterval(id)
  }, [])

  return { pin, secsLeft }
}
