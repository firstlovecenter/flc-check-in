import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { getCurrentUser, isTokenExpired, refreshSession, logout, verifySuperPrivilegesBackground } from '../utils/auth'
import { syncGraphProfileForUserBackground } from '../utils/graphProfileSync'
import LocationPermissionBanner from './LocationPermissionBanner'
import Spinner from './Spinner'

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
