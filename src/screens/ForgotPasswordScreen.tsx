import { useState } from 'react'
import { Link } from 'react-router-dom'
import { requestPasswordReset } from '../utils/auth'
import { AuthLayout } from '../components/layout/AuthLayout'
import { Alert } from '../components/ui/alert'
import { Label } from '../components/ui/label'
import { Input } from '../components/ui/input'
import { Button } from '../components/ui/button'

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
    <AuthLayout title='Reset your password' subtitle='We’ll email you a secure link'>
      {sent ? (
        <div className='flex flex-col gap-4'>
          <Alert variant='success' className='text-center'>
            Check your email — we&apos;ve sent a reset link to <strong>{email}</strong>.
          </Alert>
          <Link to='/' className='btn-pill btn-secondary w-full text-center no-underline'>
            Back to Sign In
          </Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className='flex flex-col gap-5'>
          <p className='m-0 text-sm text-muted-foreground'>
            Enter your email and we&apos;ll send you a link to reset your password.
          </p>
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='forgot-email'>Email</Label>
            <Input
              id='forgot-email'
              type='email'
              autoComplete='email'
              placeholder='your@email.com'
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          {error && <Alert variant='destructive'>{error}</Alert>}

          <Button type='submit' disabled={loading} className='w-full' size='lg'>
            {loading ? 'Sending…' : 'Send Reset Link'}
          </Button>

          <Link
            to='/'
            className='text-center text-sm text-muted-foreground no-underline hover:text-primary'
          >
            ← Back to Sign In
          </Link>
        </form>
      )}
    </AuthLayout>
  )
}
