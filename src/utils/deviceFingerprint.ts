// Device fingerprint singleton. The agent loads once per tab, caches the
// visitorId in sessionStorage, and serves subsequent calls from cache.

import FingerprintJS from '@fingerprintjs/fingerprintjs'

const STORAGE_KEY = 'flc.checkin.deviceFingerprint'
let pending: Promise<string> | null = null

export async function getDeviceFingerprint(): Promise<string> {
  // Check cache first — avoids loading the FingerprintJS agent entirely on
  // subsequent calls within the same browser session.
  const cached = sessionStorage.getItem(STORAGE_KEY)
  if (cached) return cached
  // Deduplicate concurrent callers (e.g. QR + PIN handlers racing on first use).
  if (pending) return pending
  pending = FingerprintJS.load()
    .then((fp) => fp.get())
    .then(({ visitorId }) => {
      sessionStorage.setItem(STORAGE_KEY, visitorId)
      return visitorId
    })
    .finally(() => {
      pending = null  // clear so a cleared sessionStorage can re-trigger
    })
  return pending
}
