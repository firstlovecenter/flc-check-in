// Top-of-app banner that appears whenever the browser has explicitly DENIED
// geolocation. The check-in flow is unusable without location, so making
// the failure mode visible (with platform-specific recovery guidance) is
// more useful than silently failing at the moment of check-in.
//
// Only renders for state === 'denied'. 'prompt' and 'granted' show nothing.

import { useEffect, useState } from 'react'

type Perm = 'unknown' | 'granted' | 'prompt' | 'denied'

function detectPlatform(): 'ios' | 'android' | 'desktop' {
  if (typeof navigator === 'undefined') return 'desktop'
  const ua = navigator.userAgent || ''
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Android/i.test(ua)) return 'android'
  return 'desktop'
}

function platformHint(plat: 'ios' | 'android' | 'desktop'): string {
  switch (plat) {
    case 'ios':
      return 'iOS: Settings → Privacy & Security → Location Services → Safari Websites → Allow.'
    case 'android':
      return 'Android: Tap the lock icon in the address bar → Permissions → Location → Allow.'
    default:
      return 'Click the lock/site-info icon next to the address bar and re-enable Location for this site.'
  }
}

export default function LocationPermissionBanner() {
  const [perm, setPerm] = useState<Perm>('unknown')

  useEffect(() => {
    if (typeof navigator === 'undefined' || !(navigator as any).permissions) return
    let cancelled = false
    let permRef: any = null

    ;(async () => {
      try {
        permRef = await (navigator as any).permissions.query({ name: 'geolocation' })
        if (cancelled) return
        setPerm(permRef.state as Perm)
        // The Permissions API can dispatch a change event when the user
        // updates settings without reloading the page.
        permRef.addEventListener?.('change', () => {
          if (!cancelled) setPerm(permRef.state as Perm)
        })
      } catch { /* Permissions API unavailable — silent */ }
    })()

    return () => { cancelled = true }
  }, [])

  if (perm !== 'denied') return null

  const plat = detectPlatform()

  return (
    <div
      role='alert'
      className='px-4 py-2.5 text-xs'
      style={{
        background: 'rgba(232,96,74,0.08)',
        color: 'var(--coral)',
        borderBottom: '1px solid rgba(232,96,74,0.25)',
        position: 'sticky',
        top: 0,
        zIndex: 40,
        textAlign: 'center',
      }}
    >
      <strong>Location is blocked.</strong> This app needs your location to
      verify check-ins. {platformHint(plat)}
    </div>
  )
}
