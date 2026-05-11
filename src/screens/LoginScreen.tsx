import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { loginWithCredentials, logout } from '../utils/auth'
import { resolveCurrentMember, isLeaderOrAdmin } from '../utils/membersApi'

export default function LoginScreen() {
  const navigate = useNavigate()
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
      // App is leaders + admins only — confirm via the FLC member graph.
      // We give the graph 4 seconds; if it's slow or unreachable we let the
      // user in and let downstream screens handle it — don't block login.
      try {
        const memberPromise = resolveCurrentMember(user)
        const timeoutPromise = new Promise<null>((res) => setTimeout(() => res(null), 4000))
        const member = await Promise.race([memberPromise, timeoutPromise])
        if (member && !isLeaderOrAdmin(member)) {
          logout()
          setError('This app is for leaders and admins only.')
          return
        }
      } catch {
        // GraphQL unreachable — proceed.
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
        <div className='flex flex-col gap-1'>
          {/* Eyebrow */}
          <p
            className='eyebrow m-0'
            style={{ color: 'var(--muted)' }}
          >
            First Love Church
          </p>
          <h1
            className='m-0 leading-tight'
            style={{
              fontSize: '28px',
              fontWeight: 500,
              letterSpacing: '-0.02em',
              color: 'var(--text)',
            }}
          >
            Right Here,<br />Right Now
          </h1>
        </div>

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
        </form>
      </div>
    </div>
  )
}
