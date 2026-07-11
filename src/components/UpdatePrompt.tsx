import { useEffect, useRef } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { Button } from './ui/button'

// Stale-client mitigation. The browser only looks for a new service worker on
// a real navigation, which an installed PWA resumed from the home screen may
// not perform for days — so old bundles lingered and the update banner never
// appeared. Behaviors that close that gap:
//   1. Re-check hourly while the app stays open.
//   2. Re-check every time the app returns to the foreground (throttled) —
//      the common "reopen Hineni from the home screen" path.
//   3. A new version found within the first seconds of a launch applies
//      SILENTLY (the user just opened the app; nothing is in progress).
//   4. A new version found while the app was backgrounded also applies
//      SILENTLY on the next foreground — same "fresh open" intent as (3).
//      Found mid-session while already visible → show the banner instead of
//      yanking the page out from under an in-progress check-in.

const CHECK_INTERVAL_MS = 60 * 60 * 1000  // hourly while open
const MIN_CHECK_GAP_MS = 60 * 1000        // throttle foreground-triggered checks
const BOOT_AUTO_APPLY_MS = 30 * 1000      // silent-update window after launch
/** After returning from background, treat the next N ms like a fresh launch. */
const FOREGROUND_AUTO_APPLY_MS = 15_000

const bootTs = Date.now()

export default function UpdatePrompt() {
  const lastCheckRef = useRef(0)
  const foregroundedAtRef = useRef(bootTs)
  const wasHiddenRef = useRef(false)

  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return
      const check = () => {
        if (Date.now() - lastCheckRef.current < MIN_CHECK_GAP_MS) return
        lastCheckRef.current = Date.now()
        registration.update().catch(() => { /* offline — next check wins */ })
      }
      // Mounted once at the app root for the page's lifetime — no cleanup needed.
      setInterval(check, CHECK_INTERVAL_MS)
      // Immediate check on mount so installed PWAs don't wait for the interval.
      check()
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          wasHiddenRef.current = true
          return
        }
        if (document.visibilityState === 'visible') {
          if (wasHiddenRef.current) {
            foregroundedAtRef.current = Date.now()
            wasHiddenRef.current = false
          }
          check()
        }
      })
    },
  })

  useEffect(() => {
    if (!needRefresh) return

    const now = Date.now()
    const withinBootWindow = now - bootTs < BOOT_AUTO_APPLY_MS
    const withinForegroundWindow = now - foregroundedAtRef.current < FOREGROUND_AUTO_APPLY_MS
    // Only auto-apply when this feels like an open/reopen, not mid-interaction.
    if (withinBootWindow || withinForegroundWindow) {
      updateServiceWorker(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needRefresh])

  if (!needRefresh) return null

  return (
    <div className='surface-card fixed bottom-5 left-1/2 z-[9999] flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 items-center gap-4 px-5 py-4 shadow-lg'>
      <div className='min-w-0 flex-1'>
        <p className='m-0 text-sm font-semibold text-foreground'>Update available</p>
        <p className='m-0 mt-0.5 text-xs text-muted-foreground'>
          A new version of the app is ready.
        </p>
      </div>
      <Button size='sm' className='shrink-0' onClick={() => updateServiceWorker(true)}>
        Refresh
      </Button>
    </div>
  )
}
