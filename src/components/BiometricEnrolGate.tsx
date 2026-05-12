import { useEffect, useState, useCallback } from 'react'
import FaceEnrollSweep from './checkin/FaceEnrollSweep'
import { getMyFaceDescriptor, setMyFaceDescriptor } from '../utils/supabaseCheckins'
import { getCurrentUser } from '../utils/auth'

type GateState = 'checking' | 'open' | 'confirm' | 'saving' | 'done' | 'skipped'

const SKIP_KEY = 'flc.faceEnrolSkipped'

export default function BiometricEnrolGate({ children }) {
  const user = getCurrentUser()
  const [state, setState] = useState<GateState>('checking')
  const [pending, setPending] = useState<Float32Array | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!user?.userId) { setState('done'); return }
    if (sessionStorage.getItem(SKIP_KEY) === '1') { setState('skipped'); return }
    let cancelled = false
    ;(async () => {
      try {
        const existing = await getMyFaceDescriptor(user.userId)
        if (cancelled) return
        setState(existing ? 'done' : 'open')
      } catch {
        if (!cancelled) setState('done')  // fail open — don't block the app on a transient error
      }
    })()
    return () => { cancelled = true }
  }, [user?.userId])

  const handleCaptured = useCallback((descriptor: Float32Array) => {
    setPending(descriptor)
    setState('confirm')
  }, [])

  const handleSave = useCallback(async () => {
    if (!pending || !user?.userId) return
    setState('saving')
    setError(null)
    try {
      await setMyFaceDescriptor(user.userId, pending)
      setState('done')
    } catch (err: any) {
      setError(err?.message || 'Could not save your face data')
      setState('confirm')
    }
  }, [pending, user?.userId])

  const handleRetake = useCallback(() => {
    setPending(null)
    setError(null)
    setState('open')
  }, [])

  const handleSkip = useCallback(() => {
    sessionStorage.setItem(SKIP_KEY, '1')
    setState('skipped')
  }, [])

  const showModal = state === 'open' || state === 'confirm' || state === 'saving'

  return (
    <>
      {children}
      {showModal && (
        <div
          className='fixed inset-0 z-50 flex items-center justify-center px-4'
          style={{ background: 'rgba(0,0,0,0.7)' }}
        >
          <div
            className='w-full max-w-md p-6 flex flex-col gap-4'
            style={{
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-card)',
              boxShadow: 'var(--shadow-3)',
            }}
          >
            <div>
              <h2 className='text-lg font-semibold m-0' style={{ color: 'var(--text)' }}>
                Set up Face ID
              </h2>
              <p className='text-xs m-0 mt-1' style={{ color: 'var(--muted)' }}>
                We'll capture your face from a few angles so you can check in
                with Face ID later. Slowly move your head when prompted.
              </p>
            </div>

            {state === 'open' && (
              <FaceEnrollSweep
                onComplete={handleCaptured}
                onError={(err) => setError(err.message)}
              />
            )}

            {(state === 'confirm' || state === 'saving') && (
              <div className='flex flex-col gap-3 items-center py-4'>
                <div style={{
                  width: 64, height: 64, borderRadius: '50%',
                  background: 'rgba(46,203,143,0.15)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 32,
                }}>OK</div>
                <p className='text-sm m-0 text-center' style={{ color: 'var(--text)' }}>
                  Captured. Save your Face ID?
                </p>
                <p className='text-xs m-0 text-center' style={{ color: 'var(--muted)' }}>
                  You can re-enrol any time from your profile.
                </p>
              </div>
            )}

            {error && (
              <p
                className='text-sm px-3 py-2 text-center m-0'
                style={{
                  color: 'var(--coral)',
                  background: 'rgba(232,96,74,0.1)',
                  border: '1px solid rgba(232,96,74,0.2)',
                  borderRadius: 'var(--radius-btn)',
                }}
              >
                {error}
              </p>
            )}

            <div className='flex gap-2'>
              <button
                type='button'
                onClick={handleSkip}
                disabled={state === 'saving'}
                className='btn-pill btn-secondary flex-1 py-2.5 text-sm font-semibold cursor-pointer disabled:opacity-50'
              >
                Skip for now
              </button>
              {state === 'confirm' && (
                <button
                  type='button'
                  onClick={handleRetake}
                  className='btn-pill btn-secondary flex-1 py-2.5 text-sm font-semibold cursor-pointer'
                >
                  Retake
                </button>
              )}
              {(state === 'confirm' || state === 'saving') && (
                <button
                  type='button'
                  onClick={handleSave}
                  disabled={state === 'saving'}
                  className='btn-pill btn-primary flex-1 py-2.5 text-sm font-semibold cursor-pointer disabled:opacity-50'
                >
                  {state === 'saving' ? 'Saving…' : 'Save Face ID'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
