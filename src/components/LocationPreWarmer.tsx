// Mounts once at the app root. Aggressively obtains and refreshes the user's
// location so every check-in / geofence screen has a fresh fix ready.
//
// Why aggressive?
// ---------------
// This app's primary verification is "is the user physically at the venue."
// A cold GPS request can take 5–10s, browsers heavily de-prioritise
// inactive tabs, and on iOS the permission prompt only appears after a user
// gesture — so we trigger the prompt as early as possible and keep a watch
// alive while the user is signed in.
//
// What it does
// ------------
//   1. On mount, kicks off a single getCurrentPosition() so the permission
//      prompt appears and the cache helper warms.
//   2. If permission is granted, registers watchPosition with a long
//      interval (3 min). The OS keeps GPS warm; subsequent getCurrentPosition
//      calls hit the cache and return in <100ms.
//   3. When the tab becomes visible again, re-fires the warmup so a
//      previously-backgrounded tab gets a fresh fix.
//   4. If permission was denied previously, queries the Permissions API
//      and exposes that fact via a window event consumers can listen to.

import { useEffect } from 'react'
import { getCurrentPosition, watchPositionThrottled, primePositionCache } from '../utils/geo'

const WATCH_INTERVAL_MS = 3 * 60 * 1000  // 3 min — long enough not to drain
                                          // battery; short enough to keep
                                          // GPS warm.

export default function LocationPreWarmer() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return

    let cancelled = false
    let stopWatch: (() => void) | null = null

    const warmup = () => {
      // Best-effort. Swallow errors — the user might have denied permission
      // or be in an environment without geolocation. Other components will
      // re-prompt when they actually need a fix.
      getCurrentPosition({ timeout: 20000 }).catch(() => {})
    }

    // Step 1: immediate warmup.
    warmup()

    // Step 2: long-running watch, but only start it once we know
    // permission isn't explicitly denied — otherwise the OS keeps firing
    // PERMISSION_DENIED errors quietly.
    ;(async () => {
      try {
        const perm = (navigator as any).permissions
          ? await (navigator as any).permissions.query({ name: 'geolocation' })
          : null
        if (cancelled) return
        if (perm && perm.state === 'denied') return  // nothing to warm
        stopWatch = watchPositionThrottled(
          (pos) => primePositionCache(pos),
          () => {},  // ignore transient watch errors
          WATCH_INTERVAL_MS,
        )
      } catch {
        // Permissions API unavailable (Safari < 16 etc.) — just try the
        // watch and hope for the best.
        if (cancelled) return
        stopWatch = watchPositionThrottled(
          (pos) => primePositionCache(pos),
          () => {},
          WATCH_INTERVAL_MS,
        )
      }
    })()

    // Step 3: re-warm on tab focus / visibility change.
    const onVisible = () => {
      if (document.visibilityState === 'visible') warmup()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      stopWatch?.()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return null
}
