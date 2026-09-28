import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { getCurrentUser, isTokenExpired, refreshSessionDetailed, logout } from '../utils/auth'
import { Button } from './ui/button'

// The splash is only ever shown while we genuinely wait on the network (an
// expired token being refreshed). A valid token or no token at all resolves
// synchronously and goes straight to Home / Login with no artificial hold —
// that used to cost every cold open 400 ms, and 1.2 s after a refresh.
// On native builds the OS launch splash (resources/) already covers boot.
//
// SPLASH_MIN_MS stops a very fast refresh from flashing the splash for a
// single frame; it never adds to a refresh that takes longer than this.
const SPLASH_MIN_MS = 250
const SPLASH_FLAG = 'flc.splashShown'

type State = 'pending' | 'skip' | 'authed' | 'guest' | 'retry'

/** Decide without touching the network when we can. */
function initialState(): State {
  if (sessionStorage.getItem(SPLASH_FLAG) === '1') return 'skip'
  const accessToken = localStorage.getItem('accessToken')
  if (!accessToken) return 'guest'
  if (!isTokenExpired(accessToken)) return getCurrentUser() ? 'authed' : 'guest'
  return 'pending' // expired → must refresh over the network
}

export default function SplashScreen({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const [done, setDone] = useState<State>(initialState)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (done !== 'pending') {
      if (done !== 'retry') sessionStorage.setItem(SPLASH_FLAG, '1')
      return
    }

    let cancelled = false
    const start = Date.now()

    // Only clear the session on a real auth rejection; a network blip keeps
    // tokens so Retry can succeed.
    refreshSessionDetailed().then((result) => {
      const next: State = result.status === 'ok'
        ? 'authed'
        : result.status === 'unavailable' ? 'retry' : 'guest'
      if (next === 'guest') logout()
      const remaining = Math.max(0, SPLASH_MIN_MS - (Date.now() - start))
      setTimeout(() => { if (!cancelled) setDone(next) }, remaining)
    })

    return () => { cancelled = true }
  }, [done, attempt])

  if (done === 'skip')   return <>{children}</>
  if (done === 'authed') return <Navigate to='/home' replace />
  if (done === 'guest')  return <>{children}</>
  if (done === 'retry') {
    return (
      <div className='fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-brand px-6 text-center'>
        <p className='m-0 text-lg font-semibold text-brand-foreground'>{t('auth.session.cantReach')}</p>
        <p className='m-0 max-w-xs text-sm text-brand-foreground/80'>
          {t('auth.session.cantReachSplashBody')}
        </p>
        <Button
          type='button'
          variant='secondary'
          onClick={() => { setDone('pending'); setAttempt((n) => n + 1) }}
        >
          {t('auth.session.tryAgain')}
        </Button>
      </div>
    )
  }

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
          aria-label={t('brand.name')}
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
          <p className='m-0 text-2xl font-bold tracking-tight text-brand-foreground'>{t('brand.name')}</p>
          <p className='m-0 mt-1 text-sm font-medium text-brand-foreground/80'>{t('brand.tagline')}</p>
        </div>
      </div>
    </div>
  )
}
