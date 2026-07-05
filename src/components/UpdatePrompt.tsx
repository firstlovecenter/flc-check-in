import { useEffect, useRef } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { Button } from './ui/button'

// Stale-client mitigation. The browser only looks for a new service worker on
// a real navigation, which an installed PWA resumed from the home screen may
// not perform for days — so old bundles lingered and the update banner never
// appeared. Three behaviors close that gap:
//   1. Re-check hourly while the app stays open.
//   2. Re-check every time the app returns to the foreground (throttled) —
//      the common "reopen Hineni from the home screen" path.
//   3. A new version found within the first seconds of a launch applies
//      SILENTLY (the user just opened the app; nothing is in progress).
//      Found later — mid-session, possibly mid-check-in — it shows the
//      banner instead of yanking the page out from under them.

const CHECK_INTERVAL_MS = 60 * 60 * 1000  // hourly while open
const MIN_CHECK_GAP_MS = 60 * 1000        // throttle foreground-triggered checks
const BOOT_AUTO_APPLY_MS = 30 * 1000      // silent-update window after launch

const bootTs = Date.now()

export default function UpdatePrompt() {
  const lastCheckRef = useRef(0)
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
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check()
      })
    },
  })

  useEffect(() => {
    if (needRefresh && Date.now() - bootTs < BOOT_AUTO_APPLY_MS) {
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
