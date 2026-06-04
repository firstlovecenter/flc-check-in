import { useEffect, useState, useCallback } from 'react'
import FaceEnrollSweep from './checkin/FaceEnrollSweep'
import { checkHasFaceId, setMyFaceDescriptor } from '../utils/supabaseCheckins'
import { getCurrentUser } from '../utils/auth'
import { Modal } from './ui/modal'
import { Alert } from './ui/alert'
import { Button } from './ui/button'

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
        const enrolled = await checkHasFaceId(user.userId)
        if (cancelled) return
        setState(enrolled ? 'done' : 'open')
      } catch {
        if (!cancelled) setState('done')
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
      <Modal open={showModal} onClose={handleSkip}>
        <h2 className='m-0 text-lg font-semibold text-foreground'>Set up Face ID</h2>
        <p className='m-0 mt-1 text-xs text-muted-foreground'>
          We&apos;ll capture your face from a few angles so you can check in with Face ID later.
          Slowly move your head when prompted.
        </p>

        {state === 'open' && (
          <FaceEnrollSweep onComplete={handleCaptured} onError={(err) => setError(err.message)} />
        )}

        {(state === 'confirm' || state === 'saving') && (
          <div className='flex flex-col items-center gap-3 py-4'>
            <div className='flex size-16 items-center justify-center rounded-full bg-success/15 text-[32px]'>
              OK
            </div>
            <p className='m-0 text-center text-sm text-foreground'>Captured. Save your Face ID?</p>
            <p className='m-0 text-center text-xs text-muted-foreground'>
              You can re-enrol any time from your profile.
            </p>
          </div>
        )}

        {error && <Alert variant='destructive'>{error}</Alert>}

        <div className='flex gap-2'>
          <Button type='button' variant='outline' onClick={handleSkip} disabled={state === 'saving'} className='flex-1'>
            Skip for now
          </Button>
          {state === 'confirm' && (
            <Button type='button' variant='secondary' onClick={handleRetake} className='flex-1'>
              Retake
            </Button>
          )}
          {(state === 'confirm' || state === 'saving') && (
            <Button type='button' onClick={handleSave} disabled={state === 'saving'} className='flex-1'>
              {state === 'saving' ? 'Saving…' : 'Save Face ID'}
            </Button>
          )}
        </div>
      </Modal>
    </>
  )
}
