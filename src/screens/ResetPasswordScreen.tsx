import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { confirmPasswordReset } from '../utils/auth'
import { AuthLayout } from '../components/layout/AuthLayout'
import { Label } from '../components/ui/label'
import { Input } from '../components/ui/input'
import { Button } from '../components/ui/button'
import { cn } from '../lib/utils'

function ArrowLeftIcon() {
  return (
    <svg viewBox='0 0 24 24' width='16' height='16' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden>
      <path d='m12 19-7-7 7-7' />
      <path d='M19 12H5' />
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

export default function ResetPasswordScreen() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const token = params.get('token') || ''

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  if (!token) {
    return (
      <AuthLayout>
        <div className='mb-5'>
          <h2 className='text-lg font-semibold tracking-tight text-foreground'>Invalid link</h2>
          <p className='mt-0.5 text-sm text-muted-foreground'>
            This reset link is missing or invalid. Request a new one to continue.
          </p>
        </div>
        <Button type='button' className='w-full min-h-11' onClick={() => navigate('/forgot-password')}>
          Request a new link
        </Button>
        <p className='mt-5 text-center text-xs text-muted-foreground'>
          <Link to='/' className='text-muted-foreground no-underline hover:text-primary'>
            Back to sign in
          </Link>
        </p>
      </AuthLayout>
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    setLoading(true)
    try {
      await confirmPasswordReset(token, password)
      navigate('/?reset=success')
    } catch (err: any) {
      setError(err.message || 'Reset failed. The link may have expired.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthLayout>
      <Link
        to='/'
        className='mb-4 flex min-h-11 items-center gap-1.5 rounded text-sm text-muted-foreground no-underline transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      >
        <ArrowLeftIcon />
        Back to sign in
      </Link>

      <div className='mb-5'>
        <h2 className='text-lg font-semibold tracking-tight text-foreground'>Choose a new password</h2>
        <p className='mt-0.5 text-sm text-muted-foreground'>
          Enter a new password for your account.
        </p>
      </div>

      {error && (
        <div
          role='alert'
          className='mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive'
        >
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className='space-y-4'>
        <div className='space-y-1.5'>
          <Label htmlFor='reset-password'>New password</Label>
          <div className='relative'>
            <Input
              id='reset-password'
              type={showPassword ? 'text' : 'password'}
              autoComplete='new-password'
              placeholder='Min. 8 characters'
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
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              tabIndex={-1}
            >
              <EyeIcon open={showPassword} />
            </button>
          </div>
        </div>

        <div className='space-y-1.5'>
          <Label htmlFor='reset-confirm'>Confirm password</Label>
          <div className='relative'>
            <Input
              id='reset-confirm'
              type={showConfirm ? 'text' : 'password'}
              autoComplete='new-password'
              placeholder='Repeat your password'
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              disabled={loading}
              className='pr-11'
            />
            <button
              type='button'
              onClick={() => setShowConfirm((v) => !v)}
              className='absolute right-0 top-0 flex size-11 items-center justify-center rounded-r-lg text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
              aria-label={showConfirm ? 'Hide password' : 'Show password'}
              tabIndex={-1}
            >
              <EyeIcon open={showConfirm} />
            </button>
          </div>
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
              Saving…
            </>
          ) : (
            <>
              Set new password
              <ArrowRightIcon />
            </>
          )}
        </Button>
      </form>
    </AuthLayout>
  )
}
