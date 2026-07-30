import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AuthLayout } from '../components/layout/AuthLayout'
import { Label } from '../components/ui/label'
import { Input } from '../components/ui/input'
import { Button } from '../components/ui/button'
import { loginWithCredentials, logout } from '../utils/auth'
import { verifyLoginEligibility } from '../utils/loginEligibility'
import { friendlyErrorMessage } from '../utils/network'
import { cn } from '../lib/utils'

function EyeIcon({ open }: { open: boolean }) {
  if (open) {
    return (
      <svg viewBox='0 0 24 24' width='16' height='16' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden>
        <path d='M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94' />
        <path d='M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19' />
        <path d='M14.12 14.12a3 3 0 1 1-4.24-4.24' />
        <line x1='1' y1='1' x2='23' y2='23' />
      </svg>
    )
  }
  return (
    <svg viewBox='0 0 24 24' width='16' height='16' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden>
      <path d='M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z' />
      <circle cx='12' cy='12' r='3' />
    </svg>
  )
}

function ArrowRightIcon() {
  return (
    <svg viewBox='0 0 24 24' width='16' height='16' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden className='transition-transform group-hover:translate-x-0.5'>
      <path d='M5 12h14' />
      <path d='m13 6 6 6-6 6' />
    </svg>
  )
}

function SpinnerIcon() {
  return (
    <svg viewBox='0 0 24 24' width='16' height='16' fill='none' stroke='currentColor' strokeWidth='2' className='animate-spin' aria-hidden>
      <path d='M21 12a9 9 0 1 1-6.219-8.56' />
    </svg>
  )
}

export default function LoginScreen() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const resetSuccess = params.get('reset') === 'success'
  const notLeader = params.get('notLeader') === '1'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(
    notLeader ? t('auth.signIn.leadersOnly') : '',
  )

  async function handleSubmit(e: { preventDefault: () => void }) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const user = await loginWithCredentials(email, password)
      const eligibility = await verifyLoginEligibility(user)
      if (!eligibility.eligible) {
        logout()
        setError(t('auth.signIn.leadersOnly'))
        return
      }

      navigate('/home')
    } catch (err: any) {
      logout()
      setError(friendlyErrorMessage(err) || t('auth.signIn.genericError'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthLayout>
      <div className='mb-5'>
        <h2 className='text-lg font-semibold tracking-tight text-foreground'>{t('auth.signIn.title')}</h2>
        <p className='mt-0.5 text-sm text-muted-foreground'>
          {t('auth.signIn.subtitle')}
        </p>
      </div>

      {resetSuccess && (
        <div
          role='status'
          className='mb-4 rounded-lg border border-success/30 bg-success/10 px-3 py-2.5 text-sm text-success'
        >
          {t('auth.signIn.resetSuccess')}
        </div>
      )}

      {error && (
        <div
          role='alert'
          className='mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive'
        >
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className='space-y-4' noValidate>
        <div className='space-y-1.5'>
          <Label htmlFor='login-email'>{t('auth.signIn.emailLabel')}</Label>
          <Input
            id='login-email'
            type='email'
            autoComplete='email'
            inputMode='email'
            placeholder={t('auth.signIn.emailPlaceholder')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={loading}
          />
        </div>

        <div className='space-y-1.5'>
          <Label htmlFor='login-password'>{t('auth.signIn.passwordLabel')}</Label>
          <div className='relative'>
            <Input
              id='login-password'
              type={showPassword ? 'text' : 'password'}
              autoComplete='current-password'
              placeholder={t('auth.signIn.passwordPlaceholder')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={loading}
              className='pr-11'
            />
            <button
              type='button'
              onClick={() => setShowPassword((v) => !v)}
              className='absolute right-0 top-0 flex size-11 items-center justify-center rounded-r-lg text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
              aria-label={showPassword ? t('auth.signIn.hidePassword') : t('auth.signIn.showPassword')}
              tabIndex={-1}
            >
              <EyeIcon open={showPassword} />
            </button>
          </div>
        </div>

        <div className='flex justify-end'>
          <Link
            to='/forgot-password'
            className='min-h-11 rounded px-1 text-sm text-primary no-underline hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          >
            {t('auth.signIn.forgotPassword')}
          </Link>
        </div>

        <Button
          type='submit'
          disabled={loading}
          className={cn(
            'group w-full min-h-11',
            'active:scale-[0.98] active:translate-y-px transition-transform',
          )}
        >
          {loading ? (
            <>
              <SpinnerIcon />
              {t('auth.signIn.submitting')}
            </>
          ) : (
            <>
              {t('auth.signIn.submit')}
              <ArrowRightIcon />
            </>
          )}
        </Button>
      </form>

      <p className='mt-5 text-center text-xs text-muted-foreground'>
        <Link to='/events' className='text-muted-foreground no-underline hover:text-primary'>
          {t('auth.signIn.viewMeetings')}
        </Link>
      </p>
    </AuthLayout>
  )
}
