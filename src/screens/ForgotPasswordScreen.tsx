import { useState } from 'react'
import { Link } from 'react-router-dom'
import { requestPasswordReset } from '../utils/auth'
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

function CheckIcon() {
  return (
    <svg viewBox='0 0 24 24' width='16' height='16' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden className='shrink-0'>
      <path d='M22 11.08V12a10 10 0 1 1-5.93-9.14' />
      <polyline points='22 4 12 14.01 9 11.01' />
    </svg>
  )
}

export default function ForgotPasswordScreen() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await requestPasswordReset(email)
      setSent(true)
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Try again.')
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
        <h2 className='text-lg font-semibold tracking-tight text-foreground'>Reset password</h2>
        <p className='mt-0.5 text-sm text-muted-foreground'>
          Enter your email and we&apos;ll send reset instructions.
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

      {sent && (
        <div
          role='status'
          className='mb-4 flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2.5 text-sm text-success'
        >
          <CheckIcon />
          Reset instructions sent. Check your email.
        </div>
      )}

      <form onSubmit={handleSubmit} className='space-y-4'>
        <div className='space-y-1.5'>
          <Label htmlFor='forgot-email'>Email address</Label>
          <Input
            id='forgot-email'
            type='email'
            autoComplete='email'
            inputMode='email'
            placeholder='you@example.com'
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={loading || sent}
          />
        </div>

        <Button
          type='submit'
          disabled={loading || sent}
          className={cn(
            'group w-full min-h-11',
            'active:scale-[0.98] active:translate-y-px transition-transform',
          )}
        >
          {loading ? (
            <>
              <SpinnerIcon />
              Sending…
            </>
          ) : (
            <>
              Send reset instructions
              <ArrowRightIcon />
            </>
          )}
        </Button>
      </form>

      <p className='mt-5 text-center text-xs text-muted-foreground'>
        Need help? Contact your administrator
      </p>
    </AuthLayout>
  )
}
