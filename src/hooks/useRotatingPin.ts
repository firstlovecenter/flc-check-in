// Derives the event's current 15-second rotating check-in PIN and the seconds
// until it next rotates. The derivation mirrors the server's bucketed OTP (see
// the submit_checkin RPC), so the displayed value is always one the server will
// accept. Shared by the public /events display and the in-app check-in page.

import { useEffect, useState } from 'react'
import { generateRotatingPin } from '../utils/checkinsCrypto'

export function useRotatingPin(
  event: { id: string; qr_secret_hex?: string | null } | null | undefined,
  enabled = true,
): { pin: string | null; secsLeft: number } {
  const [pin, setPin] = useState<string | null>(null)
  const [secsLeft, setSecsLeft] = useState(() => 15 - (Math.floor(Date.now() / 1000) % 15))
  // Bumped at each 15-second boundary to force regeneration of the PIN.
  const [tick, setTick] = useState(0)

  const secretHex = event?.qr_secret_hex
  const eventId = event?.id

  // Generate the PIN only when enabled (and we have a secret) — but keep the
  // countdown below running regardless, since callers also use secsLeft for a
  // QR-only rotation display.
  useEffect(() => {
    if (!enabled || !secretHex || !eventId) { setPin(null); return }
    let cancelled = false
    ;(async () => {
      const p = await generateRotatingPin({ secretHex, eventId })
      if (!cancelled) setPin(p)
    })()
    return () => { cancelled = true }
  }, [secretHex, eventId, enabled, tick])

  useEffect(() => {
    const id = setInterval(() => {
      const sl = 15 - (Math.floor(Date.now() / 1000) % 15)
      setSecsLeft(sl)
      // At the boundary the bucket has advanced — regenerate.
      if (sl === 15) setTick((t) => t + 1)
    }, 1000)
    return () => clearInterval(id)
  }, [])

  return { pin, secsLeft }
}
