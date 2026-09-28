import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useRegisterSW } from 'virtual:pwa-register/react'

// New versions install in the background and are applied at the user's NEXT
// NAVIGATION — never in the middle of a screen.
//
// This used to be registerType 'autoUpdate', which reloads the page the moment
// a new service worker activates. Updates are looked for on launch, hourly and
// on every return to the foreground, so a deploy during a service reloaded
// every open phone — including leaders halfway through typing a PIN or aiming
// at the QR code, the moment they switched back from another app.
//
// It is still automatic (no "tap to update" prompt that nobody taps — the
// reason autoUpdate was chosen): the reload rides along with a navigation the
// user already made, so it lands on the screen they were going to anyway.

const CHECK_INTERVAL_MS = 60 * 60 * 1000
const MIN_CHECK_GAP_MS = 60 * 1000

// Screens holding in-progress input or a live camera. An update waits until
// the user has left them.
const UNSAFE_TO_RELOAD = [
  /^\/checkin\//,
  /^\/admin\/events\/new/,
  /^\/events\/[^/]+\/edit/,
]

export default function UpdatePrompt() {
  const lastCheckRef = useRef(0)
  const location = useLocation()
  const firstPath = useRef(location.pathname)

  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW({
    immediate: true,
    onRegisteredSW(_url, registration) {
      if (!registration) return
      const check = () => {
        if (Date.now() - lastCheckRef.current < MIN_CHECK_GAP_MS) return
        lastCheckRef.current = Date.now()
        registration.update().catch(() => {})
      }
      check()
      setInterval(check, CHECK_INTERVAL_MS)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check()
      })
    },
  })

  useEffect(() => {
    if (!needRefresh) return
    // Only on a real navigation, not the screen the update was found on.
    if (location.pathname === firstPath.current) return
    if (UNSAFE_TO_RELOAD.some((re) => re.test(location.pathname))) return
    void updateServiceWorker(true)
  }, [needRefresh, location.pathname, updateServiceWorker])

  // Remember where we were when the update arrived, so "navigation" means
  // leaving that screen.
  useEffect(() => {
    if (!needRefresh) firstPath.current = location.pathname
  }, [needRefresh, location.pathname])

  return null
}
