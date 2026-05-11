// Device fingerprint singleton. The agent loads once per tab, caches the
// visitorId in sessionStorage, and serves subsequent calls from cache.

import FingerprintJS from '@fingerprintjs/fingerprintjs'

const STORAGE_KEY = 'flc.checkin.deviceFingerprint'
let pending = null

export async function getDeviceFingerprint() {
  const cached = sessionStorage.getItem(STORAGE_KEY)
  if (cached) return cached
  if (!pending) {
    pending = (async () => {
      const fp = await FingerprintJS.load()
      const result = await fp.get()
      const id = result.visitorId
      sessionStorage.setItem(STORAGE_KEY, id)
      return id
    })()
  }
  return pending
}
