import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { AuthLayout } from '../components/layout/AuthLayout'
import { Alert } from '../components/ui/alert'
import { Label } from '../components/ui/label'
import { Input } from '../components/ui/input'
import { Button } from '../components/ui/button'
import { loginWithCredentials, logout } from '../utils/auth'
import { resolveCurrentMember, isLeaderOrAdmin } from '../utils/membersApi'
import { friendlyErrorMessage } from '../utils/network'

function hasLeaderOrAdminRole(roles: string[] | undefined): boolean {
  return (roles || []).some((role) => /^(leader|admin)(Bacenta|Governorship|Council|Stream|Campus|Oversight|Denomination)$/.test(role))
}

export default function LoginScreen() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const resetSuccess = params.get('reset') === 'success'
  const notLeader = params.get('notLeader') === '1'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: { preventDefault: () => void }) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const user = await loginWithCredentials(email, password)

      if (!user.isSuperAdmin) {
        try {
          const member = await resolveCurrentMember(user)
          if (!member || !isLeaderOrAdmin(member)) {
            logout()
            setError('This app is for leaders and admins only.')
            return
          }
        } catch (err) {
          if (!hasLeaderOrAdminRole(user.roles)) {
            logout()
            setError(friendlyErrorMessage(err))
            return
          }
        }
      }

      navigate('/home')
    } catch (err: any) {
      setError(friendlyErrorMessage(err) || 'Login failed. Check your credentials.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthLayout title='Hineni' subtitle='Right here, right now'>
      {resetSuccess && (
        <Alert variant='success' className='text-center'>
          Password updated — sign in with your new password.
        </Alert>
      )}
      {notLeader && (
        <Alert variant='destructive' className='text-center'>
          This app is for leaders and admins only.
        </Alert>
      )}
      <form onSubmit={handleSubmit} className='flex flex-col gap-5'>
        <p className='m-0 text-center text-xs text-muted-foreground'>
          Use the same credentials as the{' '}
          <strong className='font-medium text-foreground'>Synago App</strong>.
        </p>
        <div className='flex flex-col gap-1.5'>
          <Label htmlFor='login-email'>Email</Label>
          <Input
            id='login-email'
            type='email'
            autoComplete='email'
            placeholder='your@email.com'
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className='flex flex-col gap-1.5'>
          <Label htmlFor='login-password'>Password</Label>
          <Input
            id='login-password'
            type='password'
            autoComplete='current-password'
            placeholder='••••••••'
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <Link to='/forgot-password' className='self-end text-xs font-medium text-primary no-underline hover:underline'>
            Forgot password?
          </Link>
        </div>
        {error && <Alert variant='destructive' className='text-center'>{error}</Alert>}
        <Button type='submit' disabled={loading} className='w-full' size='lg'>
          {loading ? 'Signing in…' : 'Sign in'}
        </Button>
        <Link to='/events' className='text-center text-sm text-muted-foreground no-underline hover:text-primary'>
          View meetings at this location
        </Link>
      </form>
    </AuthLayout>
  )
}
