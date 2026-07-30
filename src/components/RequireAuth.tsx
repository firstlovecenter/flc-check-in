import { useEffect, useRef, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  getCurrentUser, isTokenExpired, isTokenNearExpiry,
  refreshSession, refreshSessionDetailed, logout,
  verifySuperPrivilegesBackground,
} from '../utils/auth'
import { syncGraphProfileForUserBackground } from '../utils/graphProfileSync'
import LocationPermissionBanner from './LocationPermissionBanner'
import Spinner from './Spinner'
import { Button } from './ui/button'

type State = 'checking' | 'ok' | 'redirect' | 'retry'

// FLC access tokens live ~1h. A leader who opens a check-in/dashboard screen
// once and leaves it open for a whole service (routinely 1.5-2h+) never
// remounts this component, so the mount-only check below never re-fires —
// the token goes stale mid-service and every subsequent graph/token-exchange
// call is then correctly rejected as unauthenticated, which the rest of the
// app has no way to tell apart from a real scope/permission denial. Poll for
// near-expiry while the session is active so it refreshes silently first.
const TOKEN_CHECK_INTERVAL_MS = 60_000

export default function RequireAuth({ children }) {
  const { t } = useTranslation()
  const accessToken = localStorage.getItem('accessToken')
  const needsRefresh = accessToken && isTokenExpired(accessToken)

  // Fast path: token is valid — render immediately, no flicker
  const [state, setState] = useState<State>(
    !accessToken ? 'redirect' : needsRefresh ? 'checking' : 'ok'
  )

  useEffect(() => {
    if (state !== 'checking') return
    let cancelled = false
    refreshSessionDetailed()
      .then((result) => {
        if (cancelled) return
        if (result.status === 'ok') {
          syncGraphProfileForUserBackground(result.user, { force: true })
          setState('ok')
          return
        }
        // Real auth rejection → clear session. Network/5xx → keep tokens and
        // offer retry (venue Wi‑Fi must not look like "logged out").
        if (result.status === 'unauthorized') {
          logout()
          setState('redirect')
        } else {
          setState('retry')
        }
      })
      .catch(() => {
        if (!cancelled) setState('retry')
      })
    return () => { cancelled = true }
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
  //
  // A failed *proactive* refresh (token still valid, just near expiry) must
  // NOT log the user out — it just retries next tick / next foreground. Doing
  // otherwise would recreate the exact bug this fix targets: a transient
  // network/backend hiccup getting mistaken for a real auth failure. Only a
  // token that has actually gone expired hands off to the 'checking' state,
  // which reuses the mount-time refresh-or-logout path above.
  const refreshInFlight = useRef(false)
  useEffect(() => {
    if (state !== 'ok') return
    const checkAndRefresh = () => {
      if (refreshInFlight.current) return
      const token = localStorage.getItem('accessToken')
      if (!token) return
      if (isTokenExpired(token)) { setState('checking'); return }
      if (!isTokenNearExpiry(token)) return
      refreshInFlight.current = true
      refreshSession().finally(() => { refreshInFlight.current = false })
    }
    const id = setInterval(checkAndRefresh, TOKEN_CHECK_INTERVAL_MS)
    // setInterval is throttled/suspended by mobile OSes while the PWA is
    // backgrounded (screen lock, app switch) — routine during a 1.5-2h live
    // service. Re-check the moment the app is foregrounded again instead of
    // waiting for the next scheduled tick.
    const onVisible = () => { if (document.visibilityState === 'visible') checkAndRefresh() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', checkAndRefresh)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', checkAndRefresh)
    }
  }, [state])

  if (state === 'redirect') return <Navigate to='/' replace />
  if (state === 'checking') return <Spinner fullPage message={t('auth.session.restoring')} />
  if (state === 'retry') {
    return (
      <div className='mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center'>
        <p className='m-0 text-base font-semibold text-foreground'>{t('auth.session.cantReach')}</p>
        <p className='m-0 text-sm text-muted-foreground'>
          {t('auth.session.cantReachBody')}
        </p>
        <Button type='button' onClick={() => setState('checking')}>
          {t('auth.session.tryAgain')}
        </Button>
      </div>
    )
  }
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
