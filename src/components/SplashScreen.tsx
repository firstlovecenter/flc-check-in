import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { getCurrentUser, isTokenExpired, refreshSession, logout } from '../utils/auth'

const MIN_DURATION_MS = 5000
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
      const remaining = Math.max(0, MIN_DURATION_MS - elapsed)
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
        @keyframes flcSplashPulse {
          0%, 100% {
            transform: scale(1);
            box-shadow: 0 0 0 0 rgba(123,164,248,0.0), 0 0 40px 4px rgba(123,164,248,0.18);
          }
          50% {
            transform: scale(1.06);
            box-shadow: 0 0 0 18px rgba(123,164,248,0.0), 0 0 60px 12px rgba(123,164,248,0.35);
          }
        }
        @keyframes flcSplashHaloA {
          0%   { transform: scale(0.85); opacity: 0.45; }
          70%  { opacity: 0; }
          100% { transform: scale(1.6); opacity: 0; }
        }
        @keyframes flcSplashHaloB {
          0%   { transform: scale(0.85); opacity: 0.35; }
          70%  { opacity: 0; }
          100% { transform: scale(1.8); opacity: 0; }
        }
        @keyframes flcSplashFadeIn {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <div className='relative flex flex-col items-center gap-6'>
        {/* Expanding halo rings behind the logo */}
        <div
          className='absolute pointer-events-none'
          style={{
            width: 180, height: 180, borderRadius: '50%',
            border: '2px solid var(--accent)',
            animation: 'flcSplashHaloA 2.4s ease-out infinite',
          }}
        />
        <div
          className='absolute pointer-events-none'
          style={{
            width: 180, height: 180, borderRadius: '50%',
            border: '2px solid var(--accent)',
            animation: 'flcSplashHaloB 2.4s ease-out 1.2s infinite',
          }}
        />

        {/* Pulsing logo */}
        <img
          src='/flc-logo-circle.jpeg'
          alt='FLC'
          style={{
            width: 180, height: 180,
            borderRadius: '50%',
            objectFit: 'cover',
            animation: 'flcSplashPulse 1.8s ease-in-out infinite',
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
