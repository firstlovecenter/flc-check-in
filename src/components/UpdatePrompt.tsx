import { useRef } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'

// registerType: 'autoUpdate' (vite.config) activates new SWs and reloads.
// Installed PWAs often skip a full navigation for days, so we still poke
// registration.update() on launch, hourly, and on foreground return.

const CHECK_INTERVAL_MS = 60 * 60 * 1000
const MIN_CHECK_GAP_MS = 60 * 1000

export default function UpdatePrompt() {
  const lastCheckRef = useRef(0)

  useRegisterSW({
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

  return null
}
