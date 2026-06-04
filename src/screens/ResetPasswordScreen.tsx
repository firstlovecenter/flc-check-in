import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { confirmPasswordReset } from '../utils/auth'
import { AuthLayout } from '../components/layout/AuthLayout'
import { CenterCard } from '../components/layout/CenterCard'
import { Alert } from '../components/ui/alert'
import { Label } from '../components/ui/label'
import { Input } from '../components/ui/input'
import { Button } from '../components/ui/button'

export default function ResetPasswordScreen() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const token = params.get('token') || ''

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  if (!token) {
    return (
      <CenterCard>
        <p className='m-0 text-sm text-destructive'>
          Invalid or missing reset link. Please request a new one.
        </p>
        <Link to='/forgot-password' className='btn-pill btn-primary mt-4 block w-full text-center no-underline'>
          Forgot Password
        </Link>
      </CenterCard>
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
    <AuthLayout title='Choose a new password'>
      <form onSubmit={handleSubmit} className='flex flex-col gap-5'>
        <div className='flex flex-col gap-1.5'>
          <Label htmlFor='reset-password'>New Password</Label>
          <Input
            id='reset-password'
            type='password'
            autoComplete='new-password'
            placeholder='Min. 8 characters'
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        <div className='flex flex-col gap-1.5'>
          <Label htmlFor='reset-confirm'>Confirm Password</Label>
          <Input
            id='reset-confirm'
            type='password'
            autoComplete='new-password'
            placeholder='Repeat your password'
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </div>

        {error && <Alert variant='destructive'>{error}</Alert>}

        <Button type='submit' disabled={loading} className='w-full' size='lg'>
          {loading ? 'Saving…' : 'Set New Password'}
        </Button>

        <Link
          to='/'
          className='text-center text-sm text-muted-foreground no-underline hover:text-primary'
        >
          ← Back to Sign In
        </Link>
      </form>
    </AuthLayout>
  )
}
