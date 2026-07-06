import { useEffect, useRef, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { getCurrentUser, isTokenExpired, isTokenNearExpiry, refreshSession, logout, verifySuperPrivilegesBackground } from '../utils/auth'
import { syncGraphProfileForUserBackground } from '../utils/graphProfileSync'
import LocationPermissionBanner from './LocationPermissionBanner'
import Spinner from './Spinner'

type State = 'checking' | 'ok' | 'redirect'

// FLC access tokens live ~1h. A leader who opens a check-in/dashboard screen
// once and leaves it open for a whole service (routinely 1.5-2h+) never
// remounts this component, so the mount-only check below never re-fires —
// the token goes stale mid-service and every subsequent graph/token-exchange
// call is then correctly rejected as unauthenticated, which the rest of the
// app has no way to tell apart from a real scope/permission denial. Poll for
// near-expiry while the session is active so it refreshes silently first.
const TOKEN_CHECK_INTERVAL_MS = 60_000

export default function RequireAuth({ children }) {
  const accessToken = localStorage.getItem('accessToken')
  const needsRefresh = accessToken && isTokenExpired(accessToken)

  // Fast path: token is valid — render immediately, no flicker
  const [state, setState] = useState<State>(
    !accessToken ? 'redirect' : needsRefresh ? 'checking' : 'ok'
  )

  useEffect(() => {
    if (state !== 'checking') return
    refreshSession()
      .then((user) => {
        if (user) {
          syncGraphProfileForUserBackground(user, { force: true })
          setState('ok')
        } else {
          logout()
          setState('redirect')
        }
      })
      .catch(() => {
        logout()
        setState('redirect')
      })
  }, [state])

  // Returning session (valid token): re-probe graph periodically for scope moves,
  // and re-verify the superadmin/superviewer flags against the Supabase
  // allowlists (throttled inside verifySuperPrivileges).
  useEffect(() => {
    if (state !== 'ok') return
    const user = getCurrentUser()
    if (user) {
      syncGraphProfileForUserBackground(user)
      verifySuperPrivilegesBackground(user)
    }
  }, [state])

  // Background token refresh for long-lived mounts (see TOKEN_CHECK_INTERVAL_MS
  // above). refreshInFlight guards against a slow/flaky connection causing two
  // overlapping refresh attempts if one tick's call hasn't resolved by the next.
  const refreshInFlight = useRef(false)
  useEffect(() => {
    if (state !== 'ok') return
    const id = setInterval(() => {
      if (refreshInFlight.current) return
      const token = localStorage.getItem('accessToken')
      if (!token || !isTokenNearExpiry(token)) return
      refreshInFlight.current = true
      refreshSession()
        .then((user) => {
          if (!user) { logout(); setState('redirect') }
        })
        .catch(() => { logout(); setState('redirect') })
        .finally(() => { refreshInFlight.current = false })
    }, TOKEN_CHECK_INTERVAL_MS)
    return () => clearInterval(id)
  }, [state])

  if (state === 'redirect') return <Navigate to='/' replace />
  if (state === 'checking') return <Spinner fullPage />
  if (!getCurrentUser()) return <Navigate to='/' replace />
  // LocationPreWarmer is intentionally NOT mounted here. Most authed routes
  // (home, history, reports, biometrics, profile, etc.) never need GPS, so a
  // 20-second getCurrentPosition() + 3-minute watch on every authed page was
  // a lot of wasted radio time. It is now mounted directly inside the screens
  // that actually use the cached position (check-in, geofence picker).
  return (
    <>
      <LocationPermissionBanner />
      {children}
    </>
  )
}
