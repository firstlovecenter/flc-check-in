import { useState } from 'react'
import { Link } from 'react-router-dom'
import { requestPasswordReset } from '../utils/auth'

export default function ForgotPasswordScreen() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
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
            Reset your<br />password
          </h1>
        </div>

        {sent ? (
          <div className='flex flex-col gap-4'>
            <div
              className='p-4 text-sm text-center'
              style={{
                background: 'rgba(46,203,143,0.08)',
                color: 'var(--green)',
                border: '1px solid rgba(46,203,143,0.25)',
                borderRadius: 'var(--radius-btn)',
              }}
            >
              Check your email — we've sent a reset link to <strong>{email}</strong>.
            </div>
            <Link
              to='/'
              className='btn-pill btn-secondary w-full text-center'
              style={{ fontSize: '14px' }}
            >
              Back to Sign In
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className='flex flex-col gap-5'>
            <p className='text-sm m-0' style={{ color: 'var(--muted)' }}>
              Enter your email and we'll send you a link to reset your password.
            </p>
            <div className='flex flex-col gap-2'>
              <label className='eyebrow' style={{ color: 'var(--muted)' }}>Email</label>
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
              style={{ fontSize: '15px', padding: '13px 24px' }}
            >
              {loading ? 'Sending…' : 'Send Reset Link'}
            </button>

            <Link
              to='/'
              className='text-sm text-center'
              style={{ color: 'var(--muted)', textDecoration: 'none' }}
            >
              ← Back to Sign In
            </Link>
          </form>
        )}
      </div>
    </div>
  )
}
