import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { loginWithCredentials, logout } from '../utils/auth'
import { resolveCurrentMember, isLeaderOrAdmin } from '../utils/membersApi'

export default function LoginScreen() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const resetSuccess = params.get('reset') === 'success'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const user = await loginWithCredentials(email, password)
      // Superadmins bypass the FLC member graph entirely.
      if (!user.isSuperAdmin) {
        // Confirm the user is a leader/admin via the FLC member graph.
        // 4-second timeout so a slow/unreachable graph doesn't block login.
        try {
          const memberPromise = resolveCurrentMember(user)
          const timeoutPromise = new Promise<null>((res) => setTimeout(() => res(null), 2000))
          const member = await Promise.race([memberPromise, timeoutPromise])
          if (member && !isLeaderOrAdmin(member)) {
            logout()
            setError('This app is for leaders and admins only.')
            return
          }
        } catch {
          // GraphQL unreachable — proceed.
        }
      }
      navigate('/home')
    } catch (err: any) {
      setError(err.message || 'Login failed. Check your credentials.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className='min-h-dvh flex items-center justify-center px-4 py-12'
      style={{ background: 'var(--bg)' }}
    >
      {/* Card */}
      <div
        className='w-full max-w-sm p-8 flex flex-col gap-8'
        style={{
          background: 'var(--card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-card)',
          boxShadow: 'var(--shadow-2)',
        }}
      >
        {/* Logo / wordmark */}
        <div className='flex flex-col items-center gap-3'>
          <img
            src='/flc-logo-circle.jpeg'
            alt='First Love Church'
            width={72}
            height={72}
            style={{ borderRadius: '50%', objectFit: 'cover' }}
          />
          <h1
            className='m-0 leading-tight text-center'
            style={{
              fontSize: '28px',
              fontWeight: 500,
              letterSpacing: '-0.02em',
              color: 'var(--text)',
            }}
          >
            Hineni<br />Right Here, Right Now
          </h1>
        </div>

        {/* Reset success banner */}
        {resetSuccess && (
          <div
            className='px-4 py-3 text-sm text-center'
            style={{
              background: 'rgba(46,203,143,0.08)',
              color: 'var(--green)',
              border: '1px solid rgba(46,203,143,0.25)',
              borderRadius: 'var(--radius-btn)',
            }}
          >
            Password updated — sign in with your new password.
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className='flex flex-col gap-5'>
          <div className='flex flex-col gap-2'>
            <label
              className='eyebrow'
              style={{ color: 'var(--muted)' }}
            >
              Email
            </label>
            <input
              type='email'
              autoComplete='email'
              placeholder='your@email.com'
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className='input-field'
              onFocus={(e) => (e.target.style.borderColor = 'var(--accent)')}
              onBlur={(e) => (e.target.style.borderColor = 'var(--border)')}
            />
          </div>

          <div className='flex flex-col gap-2'>
            <label
              className='eyebrow'
              style={{ color: 'var(--muted)' }}
            >
              Password
            </label>
            <input
              type='password'
              autoComplete='current-password'
              placeholder='••••••••'
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className='input-field'
              onFocus={(e) => (e.target.style.borderColor = 'var(--accent)')}
              onBlur={(e) => (e.target.style.borderColor = 'var(--border)')}
            />
            <Link
              to='/forgot-password'
              className='text-xs self-end'
              style={{ color: 'var(--accent)', textDecoration: 'none' }}
            >
              Forgot password?
            </Link>
          </div>

          {error && (
            <p
              className='text-sm px-4 py-3 m-0 text-center'
              style={{
                color: 'var(--coral)',
                background: 'rgba(232,96,74,0.08)',
                border: '1px solid rgba(232,96,74,0.25)',
                borderRadius: 'var(--radius-btn)',
              }}
            >
              {error}
            </p>
          )}

          <button
            type='submit'
            disabled={loading}
            className='btn-pill btn-primary w-full'
            style={{ marginTop: '4px', fontSize: '15px', padding: '13px 24px' }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>

          <Link
            to='/events'
            className='text-sm text-center'
            style={{ color: 'var(--muted)', textDecoration: 'none' }}
          >
            View Meetings At This Location
          </Link>
        </form>
      </div>
    </div>
  )
}
