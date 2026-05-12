import { useEffect, useRef, useState } from 'react'
import {
  averageDescriptors,
  captureDescriptor,
  captureLandmarks,
  descriptorDistance,
  eyeAspectRatio,
  loadFaceModels,
} from '../../utils/faceApi'

type Mode = 'enroll' | 'verify'

interface Props {
  mode: Mode
  targetDescriptor?: Float32Array | null
  onComplete: (descriptor: Float32Array) => void
  onError?: (err: Error) => void
}

const MATCH_THRESHOLD = 0.55
// EAR varies by camera angle and face shape, so blink detection uses a
// rolling open-eye baseline with fallback fixed thresholds.
const EAR_OPEN        = 0.23
const EAR_CLOSED      = 0.19
const EAR_DROP_RATIO  = 0.82
const EAR_RISE_RATIO  = 0.90
const BASELINE_ALPHA  = 0.14
const ENROLL_FRAMES   = 3
const RECOGNITION_INTERVAL = 120
const LIVENESS_INTERVAL    = 35

type Status = 'idle' | 'loading-models' | 'starting-camera' | 'ready' | 'capturing' | 'complete' | 'error'

export default function FaceCapture({ mode, targetDescriptor, onComplete, onError }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState('Loading models...')
  const [dotCount, setDotCount] = useState(0)
  const blinkDone = useRef(false)

  useEffect(() => {
    let stopped = false
    let stream: MediaStream | null = null
    let detectTimer: ReturnType<typeof setTimeout> | null = null

    const collected: Float32Array[] = []
    let faceMatched = false
    let blinkArmed = false
    let eyesClosed = false
    let closedFrames = 0
    let openEarBaseline = 0
    blinkDone.current = false

    async function start() {
      try {
        setStatus('loading-models')
        setMessage('Loading face models...')
        await loadFaceModels()
        if (stopped) return

        setStatus('starting-camera')
        setMessage('Starting camera...')
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 320 } },
          audio: false,
        })
        if (stopped) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }

        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play().catch(() => {})
        }

        setStatus('ready')
        setMessage(mode === 'enroll' ? 'Look at the camera' : 'Look at the camera, then blink')
        loop()
      } catch (err: any) {
        if (stopped) return
        setStatus('error')
        const msg = err?.message || 'Camera error'
        setMessage(msg)
        onError?.(err instanceof Error ? err : new Error(msg))
      }
    }

    async function loop() {
      if (stopped || !videoRef.current) return
      const video = videoRef.current
      const useFastLiveness = mode === 'verify' && faceMatched && !blinkDone.current
      const nextInterval = useFastLiveness ? LIVENESS_INTERVAL : RECOGNITION_INTERVAL

      if (video.readyState >= 2 && video.videoWidth > 0) {
        try {
          if (useFastLiveness) {
            const cap = await captureLandmarks(video)
            if (stopped) return
            if (cap) {
              handleBlinkFrame(eyeAspectRatio(cap.landmarks))
            } else {
              faceMatched = false
              resetBlink()
              setStatus('ready')
              setMessage('Keep your face in the circle')
            }
          } else {
            const cap = await captureDescriptor(video)
            if (stopped) return
            if (cap) {
              handleDescriptorFrame(cap.descriptor, eyeAspectRatio(cap.landmarks))
            } else {
              setStatus('ready')
              setMessage(mode === 'enroll' ? 'Look at the camera' : 'Look at the camera, then blink')
            }
          }
        } catch (_) {
          // Ignore single-frame detection failures; the next frame usually recovers.
        }
      }

      if (!stopped) detectTimer = setTimeout(loop, nextInterval)
    }

    function handleDescriptorFrame(descriptor: Float32Array, ear: number) {
      if (stopped) return

      if (mode === 'enroll') {
        collected.push(descriptor)
        const n = collected.length
        setStatus('capturing')
        setDotCount(n)
        setMessage(`Hold still... ${n} of ${ENROLL_FRAMES}`)
        if (n >= ENROLL_FRAMES) finish(averageDescriptors(collected))
        return
      }

      if (!targetDescriptor) return
      const isMatch = descriptorDistance(descriptor, targetDescriptor) <= MATCH_THRESHOLD
      setStatus('capturing')

      if (!faceMatched) {
        if (!isMatch) {
          resetBlink()
          setMessage('Face not recognised - adjust lighting or position')
          return
        }
        faceMatched = true
        handleBlinkFrame(ear)
        return
      }

      if (!blinkDone.current) {
        handleBlinkFrame(ear)
        return
      }

      if (!isMatch) {
        faceMatched = false
        resetBlink()
        setMessage('Blink detected - hold still for final match')
        return
      }

      finish(descriptor)
    }

    function handleBlinkFrame(ear: number) {
      if (stopped) return

      if (!eyesClosed && ear > EAR_OPEN) {
        openEarBaseline = openEarBaseline
          ? (openEarBaseline * (1 - BASELINE_ALPHA)) + (ear * BASELINE_ALPHA)
          : ear
      }

      const closedThreshold = openEarBaseline
        ? Math.max(EAR_CLOSED, openEarBaseline * EAR_DROP_RATIO)
        : EAR_CLOSED
      const openThreshold = openEarBaseline
        ? Math.max(EAR_OPEN, openEarBaseline * EAR_RISE_RATIO)
        : EAR_OPEN

      if (ear >= openThreshold) {
        if (!blinkArmed) {
          blinkArmed = true
        } else if (eyesClosed) {
          blinkDone.current = true
        }
        closedFrames = 0
        eyesClosed = false
      } else if (ear <= closedThreshold && blinkArmed) {
        closedFrames += 1
        if (closedFrames >= 1) eyesClosed = true
      }

      setStatus('capturing')

      if (!blinkDone.current) {
        setMessage(eyesClosed ? 'Blink seen - open your eyes' : 'Match found - blink once')
        return
      }

      setMessage('Blink detected - hold still')
    }

    function resetBlink() {
      blinkArmed = false
      eyesClosed = false
      closedFrames = 0
      openEarBaseline = 0
      blinkDone.current = false
    }

    function finish(descriptor: Float32Array) {
      if (stopped) return
      stopped = true
      if (detectTimer) clearTimeout(detectTimer)
      setStatus('complete')
      setMessage(mode === 'enroll' ? 'Enrollment captured!' : 'Identity verified!')
      onComplete(descriptor)
    }

    start()

    return () => {
      stopped = true
      if (detectTimer) clearTimeout(detectTimer)
      stream?.getTracks().forEach((track) => track.stop())
      if (videoRef.current) {
        try { videoRef.current.srcObject = null } catch { /* ignore */ }
      }
    }
  }, [mode, targetDescriptor, onComplete, onError])

  const isCapturing = status === 'capturing' || status === 'ready'

  return (
    <div className='flex flex-col gap-3'>
      <div
        className='relative rounded-2xl overflow-hidden mx-auto'
        style={{ background: '#000', aspectRatio: '1 / 1', width: '100%', maxWidth: 320 }}
      >
        <video
          ref={videoRef}
          className='w-full h-full object-cover'
          style={{ transform: 'scaleX(-1)' }}
          muted
          playsInline
        />

        {(status === 'idle' || status === 'loading-models' || status === 'starting-camera') && (
          <div
            className='absolute inset-0 flex flex-col items-center justify-center gap-3'
            style={{ background: 'rgba(0,0,0,0.7)' }}
          >
            <div style={{
              width: 32, height: 32, borderRadius: '50%',
              border: '3px solid var(--accent)', borderTopColor: 'transparent',
              animation: 'spin 0.8s linear infinite',
            }} />
            <p className='text-xs' style={{ color: 'rgba(255,255,255,0.7)', margin: 0 }}>{message}</p>
          </div>
        )}

        {isCapturing && (
          <div className='absolute inset-0 pointer-events-none flex items-center justify-center'>
            <div style={{
              width: '78%', height: '78%', borderRadius: '50%',
              border: '3px solid rgba(255,255,255,0.6)',
              transition: 'border-color 0.2s',
            }} />
          </div>
        )}

        {mode === 'enroll' && status === 'capturing' && (
          <div className='absolute bottom-3 left-0 right-0 flex justify-center gap-2'>
            {Array.from({ length: ENROLL_FRAMES }).map((_, i) => (
              <span key={i} style={{
                width: 8, height: 8, borderRadius: '50%',
                background: i < dotCount ? 'var(--green)' : 'rgba(255,255,255,0.35)',
                transition: 'background 0.15s',
              }} />
            ))}
          </div>
        )}

        {mode === 'verify' && status === 'capturing' && (
          <div className='absolute bottom-3 left-0 right-0 flex justify-center'>
            <span style={{
              fontSize: 11, fontWeight: 600, letterSpacing: '0.04em',
              color: blinkDone.current ? 'var(--green)' : 'rgba(255,255,255,0.7)',
              background: 'rgba(0,0,0,0.45)', borderRadius: 99, padding: '2px 10px',
            }}>
              {blinkDone.current ? 'blink detected' : 'blink once'}
            </span>
          </div>
        )}

        {status === 'complete' && (
          <div className='absolute inset-0 flex items-center justify-center' style={{ background: 'rgba(0,0,0,0.45)' }}>
            <span style={{ fontSize: 48 }}>OK</span>
          </div>
        )}
      </div>

      <p
        className='text-sm text-center m-0'
        style={{ color: status === 'error' ? 'var(--coral)' : 'var(--muted)', minHeight: '1.25rem' }}
      >
        {(status === 'ready' || status === 'capturing' || status === 'error') ? message : ''}
      </p>
    </div>
  )
}
