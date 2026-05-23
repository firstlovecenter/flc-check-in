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

  return (
    <div
      className='fixed inset-0 flex items-center justify-center'
      style={{ background: 'var(--bg)', zIndex: 100 }}
    >
      <style>{`
        @keyframes flcSplashSpin {
          from { transform: rotate(0deg) scale(1); }
          25%  { transform: rotate(30deg) scale(1.05); }
          50%  { transform: rotate(120deg) scale(1); }
          75%  { transform: rotate(150deg) scale(1.05); }
          to   { transform: rotate(240deg) scale(1); }
        }
        @keyframes flcSplashHaloA {
          0%   { transform: scale(0.7); opacity: 0.5; }
          70%  { opacity: 0; }
          100% { transform: scale(1.8); opacity: 0; }
        }
        @keyframes flcSplashHaloB {
          0%   { transform: scale(0.7); opacity: 0.35; }
          70%  { opacity: 0; }
          100% { transform: scale(2.1); opacity: 0; }
        }
        @keyframes flcSplashFadeIn {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <div className='relative flex flex-col items-center gap-6'>
        {/* Expanding halo rings */}
        <div
          className='absolute pointer-events-none'
          style={{
            width: 120, height: 120, borderRadius: '50%',
            border: '1.5px solid color-mix(in oklab, var(--accent) 55%, transparent)',
            animation: 'flcSplashHaloA 2.4s ease-out infinite',
          }}
        />
        <div
          className='absolute pointer-events-none'
          style={{
            width: 120, height: 120, borderRadius: '50%',
            border: '1.5px solid color-mix(in oklab, var(--accent) 35%, transparent)',
            animation: 'flcSplashHaloB 2.4s ease-out 1.2s infinite',
          }}
        />

        {/* Pulsing logo */}
        <img
          src='/flc-logo-circle.jpeg'
          alt='FLC'
          style={{
            width: 120, height: 120,
            borderRadius: '50%',
            objectFit: 'cover',
            animation: 'flcSplashSpin 2.4s cubic-bezier(0.4,0,0.6,1) infinite',
            position: 'relative',
            zIndex: 1,
          }}
        />

        <p
          className='text-sm m-0'
          style={{
            color: 'var(--muted)',
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            animation: 'flcSplashFadeIn 0.6s ease-out 0.3s both',
          }}
        >
          FLC Servants Check-In Portal
        </p>
      </div>
    </div>
  )
}
