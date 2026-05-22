import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { getCurrentUser, isTokenExpired, refreshSession, logout } from '../utils/auth'
import BiometricEnrolGate from './BiometricEnrolGate'
import LocationPermissionBanner from './LocationPermissionBanner'

type State = 'checking' | 'ok' | 'redirect'

export default function RequireAuth({ children }) {
  const accessToken = localStorage.getItem('accessToken')
  const needsRefresh = accessToken && isTokenExpired(accessToken)

  // Fast path: token is valid — render immediately, no flicker
  const [state, setState] = useState<State>(
    !accessToken ? 'redirect' : needsRefresh ? 'checking' : 'ok'
  )

  useEffect(() => {
    if (state !== 'checking') return
    refreshSession().then((user) => {
      if (user) {
        setState('ok')
      } else {
        logout()
        setState('redirect')
      }
    })
  }, [state])

  if (state === 'redirect') return <Navigate to='/' replace />
  if (state === 'checking') return null  // brief blank while refreshing
  if (!getCurrentUser()) return <Navigate to='/' replace />
  // LocationPreWarmer is intentionally NOT mounted here. Most authed routes
  // (home, history, reports, biometrics, profile, etc.) never need GPS, so a
  // 20-second getCurrentPosition() + 3-minute watch on every authed page was
  // a lot of wasted radio time. It is now mounted directly inside the screens
  // that actually use the cached position (check-in, geofence picker).
  return (
    <>
      <LocationPermissionBanner />
      <BiometricEnrolGate>{children}</BiometricEnrolGate>
    </>
  )
}
