import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { getCurrentUser, isTokenExpired, refreshSession, logout } from '../utils/auth'

// Splash floor durations. SessionStorage already short-circuits the splash
// entirely on warm intra-tab visits (line 17), so these only matter for the
// FIRST visit per session.
//
// MIN_DURATION_SLOW_MS  — held when auth takes a meaningful moment to
//                         resolve (refresh-token round-trip, etc.). Just
//                         long enough for the halo to play one cycle.
// MIN_DURATION_FAST_MS  — held when auth resolves synchronously (valid
//                         cached token, no network). Just long enough to
//                         avoid a jarring flash.
//
// The "fast" path is what most users see on every cold reload.
const MIN_DURATION_SLOW_MS = 1200
const MIN_DURATION_FAST_MS = 400
const FAST_AUTH_THRESHOLD_MS = 200
const SPLASH_FLAG = 'flc.splashShown'

type State = 'pending' | 'skip' | 'authed' | 'guest'

export default function SplashScreen({ children }: { children: React.ReactNode }) {
  // If we've already played the splash this session, render children directly.
  const [done, setDone] = useState<State>(() =>
    sessionStorage.getItem(SPLASH_FLAG) === '1' ? 'skip' : 'pending'
  )

  useEffect(() => {
    if (done !== 'pending') return

    let cancelled = false
    const start = Date.now()

    const authCheck = (async (): Promise<'authed' | 'guest'> => {
      const accessToken = localStorage.getItem('accessToken')
      if (!accessToken) return 'guest'
      if (!isTokenExpired(accessToken)) return getCurrentUser() ? 'authed' : 'guest'
      // Token expired — try refresh
      const user = await refreshSession()
      if (user) return 'authed'
      logout()
      return 'guest'
    })()

    authCheck.then((result) => {
      const elapsed = Date.now() - start
      // Pick the floor based on how long auth actually took. Fast resolves
      // (cached valid token) only need a short flash-prevention pause;
      // slow resolves (token refresh round-trip) hold long enough for one
      // halo cycle so the spinner doesn't look glitchy.
      const floor = elapsed <= FAST_AUTH_THRESHOLD_MS
        ? MIN_DURATION_FAST_MS
        : MIN_DURATION_SLOW_MS
      const remaining = Math.max(0, floor - elapsed)
      setTimeout(() => {
        if (cancelled) return
        sessionStorage.setItem(SPLASH_FLAG, '1')
        setDone(result)
      }, remaining)
    })

    return () => { cancelled = true }
  }, [done])

  if (done === 'skip')   return <>{children}</>
  if (done === 'authed') return <Navigate to='/home' replace />
  if (done === 'guest')  return <>{children}</>

  // Mirrors the FL Admin Portal splash (solid brand surface, white Synago
  // mark, soft pulse) — and matches the native launch splash generated from
  // resources/ so app start reads as one continuous screen.
  return (
    <div className='fixed inset-0 z-[100] flex items-center justify-center bg-brand'>
      <style>{`
        @keyframes flcSplashFadeIn {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <div className='flex flex-col items-center gap-5'>
        <svg
          viewBox='0 0 24 24'
          xmlns='http://www.w3.org/2000/svg'
          role='img'
          aria-label='Hineni'
          className='h-24 w-24 text-brand-foreground animate-[pulse_2s_ease-in-out_infinite]'
        >
          <g fill='currentColor'>
            <path d='M12 2C13.2 2 15.1 3 15.7 5C16.3 7 15.3 9 13.2 10C12.6 10.3 11.4 10.3 10.8 10C8.7 9 7.7 7 8.3 5C8.9 3 10.8 2 12 2Z' />
            <path d='M12 2C13.2 2 15.1 3 15.7 5C16.3 7 15.3 9 13.2 10C12.6 10.3 11.4 10.3 10.8 10C8.7 9 7.7 7 8.3 5C8.9 3 10.8 2 12 2Z' transform='rotate(120 12 12)' />
            <path d='M12 2C13.2 2 15.1 3 15.7 5C16.3 7 15.3 9 13.2 10C12.6 10.3 11.4 10.3 10.8 10C8.7 9 7.7 7 8.3 5C8.9 3 10.8 2 12 2Z' transform='rotate(240 12 12)' />
            <circle cx='12' cy='12' r='2.2' />
          </g>
        </svg>

        <div className='animate-[flcSplashFadeIn_0.6s_ease-out_0.3s_both] text-center'>
          <p className='m-0 text-2xl font-bold tracking-tight text-brand-foreground'>Hineni</p>
          <p className='m-0 mt-1 text-sm font-medium text-brand-foreground/80'>Right here, right now</p>
        </div>
      </div>
    </div>
  )
}
