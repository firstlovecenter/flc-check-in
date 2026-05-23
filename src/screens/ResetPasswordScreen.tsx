import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { confirmPasswordReset } from '../utils/auth'

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
      <div
        className='min-h-dvh flex items-center justify-center px-4 py-12'
        style={{ background: 'var(--bg)' }}
      >
        <div
          className='w-full max-w-sm p-8 flex flex-col gap-6 text-center'
          style={{
            background: 'var(--card)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-card)',
            boxShadow: 'var(--shadow-2)',
          }}
        >
          <p className='text-sm m-0' style={{ color: 'var(--coral)' }}>
            Invalid or missing reset link. Please request a new one.
          </p>
          <Link to='/forgot-password' className='btn-pill btn-primary w-full text-center' style={{ fontSize: '14px' }}>
            Forgot Password
          </Link>
        </div>
      </div>
    )
  }

  async function handleSubmit(e) {
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
    <div
      className='min-h-dvh flex items-center justify-center px-4 py-12'
      style={{ background: 'var(--bg)' }}
    >
      <div
        className='w-full max-w-sm p-8 flex flex-col gap-8'
        style={{
          background: 'var(--card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-card)',
          boxShadow: 'var(--shadow-2)',
        }}
      >
        <div className='flex flex-col items-center gap-3'>
          <img
            src='/apple-touch-icon.png'
            alt='First Love Church'
            width={60}
            height={60}
            className='app-logo'
          />
          <h1
            className='m-0 leading-tight text-center'
            style={{ fontSize: '24px', fontWeight: 500, letterSpacing: '-0.02em', color: 'var(--text)' }}
          >
            Choose a new<br />password
          </h1>
        </div>

        <form onSubmit={handleSubmit} className='flex flex-col gap-5'>
          <div className='flex flex-col gap-2'>
            <label className='eyebrow' style={{ color: 'var(--muted)' }}>New Password</label>
            <input
              type='password'
              autoComplete='new-password'
              placeholder='Min. 8 characters'
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className='input-field'
              onFocus={(e) => (e.target.style.borderColor = 'var(--accent)')}
              onBlur={(e) => (e.target.style.borderColor = 'var(--border)')}
            />
          </div>

          <div className='flex flex-col gap-2'>
            <label className='eyebrow' style={{ color: 'var(--muted)' }}>Confirm Password</label>
            <input
              type='password'
              autoComplete='new-password'
              placeholder='Repeat your password'
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
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
                background: 'color-mix(in oklab, var(--absent) 8%, transparent)',
                border: '1px solid color-mix(in oklab, var(--absent) 25%, transparent)',
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
            style={{ fontSize: '15px', padding: '13px 24px' }}
          >
            {loading ? 'Saving…' : 'Set New Password'}
          </button>

          <Link
            to='/'
            className='text-sm text-center'
            style={{ color: 'var(--muted)', textDecoration: 'none' }}
          >
            ← Back to Sign In
          </Link>
        </form>
      </div>
    </div>
  )
}
