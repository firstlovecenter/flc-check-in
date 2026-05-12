import { useEffect, useRef, useState } from 'react'
import {
  averageDescriptors,
  captureDescriptor,
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
// TinyFaceDetector landmarks are less precise than the full 68-point model.
// Real-world blinks with this detector typically bring EAR down to 0.22-0.28
// rather than the <0.20 seen with higher-res models.
const EAR_CLOSED      = 0.28   // eyes considered "closing" below this
const EAR_OPEN        = 0.23   // eyes considered "open" above this
const ENROLL_FRAMES   = 3
const DETECT_INTERVAL = 120    // ~8fps — catches fast blinks more reliably

type Status = 'idle' | 'loading-models' | 'starting-camera' | 'ready' | 'capturing' | 'complete' | 'error'

export default function FaceCapture({ mode, targetDescriptor, onComplete, onError }: Props) {
  const videoRef   = useRef<HTMLVideoElement | null>(null)
  const [status,   setStatus]   = useState<Status>('idle')
  const [message,  setMessage]  = useState('Loading models…')
  // enroll: 0..ENROLL_FRAMES collected; verify: 0 = no blink, 1 = blink confirmed
  const [dotCount, setDotCount] = useState(0)
  const blinkDone = useRef(false)   // verify: blink fully confirmed (open→closed→open)

  useEffect(() => {
    let stopped = false
    let stream: MediaStream | null = null
    let detectTimer: ReturnType<typeof setTimeout> | null = null

    // Mutable loop state — never read React state inside the loop
    const collected: Float32Array[] = []
    let blinkArmed    = false  // seen eyes-open baseline
    let eyesClosed    = false  // currently seeing low EAR (mid-blink)
    let closedFrames  = 0      // consecutive frames below EAR_CLOSED
    blinkDone.current = false

    async function start() {
      try {
        setStatus('loading-models')
        setMessage('Loading face models…')
        await loadFaceModels()
        if (stopped) return

        setStatus('starting-camera')
        setMessage('Starting camera…')
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 320 } },
          audio: false,
        })
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return }

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

      if (video.readyState >= 2 && video.videoWidth > 0) {
        try {
          const cap = await captureDescriptor(video)
          if (stopped) return
          if (cap) {
            handleFrame(cap.descriptor, eyeAspectRatio(cap.landmarks))
          } else {
            setStatus('ready')
            setMessage(mode === 'enroll' ? 'Look at the camera' : 'Look at the camera, then blink')
          }
        } catch (_) { /* ignore single-frame failures */ }
      }

      if (!stopped) detectTimer = setTimeout(loop, DETECT_INTERVAL)
    }

    function handleFrame(descriptor: Float32Array, ear: number) {
      if (stopped) return

      if (mode === 'enroll') {
        collected.push(descriptor)
        const n = collected.length
        setStatus('capturing')
        setDotCount(n)
        setMessage(`Hold still… ${n} of ${ENROLL_FRAMES}`)
        if (n >= ENROLL_FRAMES) finish(averageDescriptors(collected))
        return
      }

      // verify mode
      if (!targetDescriptor) return
      const dist = descriptorDistance(descriptor, targetDescriptor)

      if (dist > MATCH_THRESHOLD) {
        setStatus('capturing')
        setMessage('Face not recognised — adjust lighting or position')
        return
      }

      // Blink state machine
      // open (EAR > EAR_OPEN) → arm baseline
      // closing (EAR < EAR_CLOSED) → mark eyesClosed after 1+ consecutive frames
      // open again after eyesClosed → blink confirmed
      if (ear > EAR_OPEN) {
        if (!blinkArmed) {
          blinkArmed = true
        } else if (eyesClosed) {
          blinkDone.current = true
        }
        closedFrames = 0
        eyesClosed = false
      } else if (ear < EAR_CLOSED && blinkArmed) {
        closedFrames++
        if (closedFrames >= 1) eyesClosed = true  // 1 frame is enough at 8fps
      }

      setStatus('capturing')

      if (!blinkDone.current) {
        setMessage(`Match found — blink once to confirm  (ear: ${ear.toFixed(3)})`)
        return
      }

      // Match + blink confirmed
      finish(descriptor)
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
      stream?.getTracks().forEach((t) => t.stop())
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

        {/* Loading overlay */}
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

        {/* Circular face guide */}
        {isCapturing && (
          <div className='absolute inset-0 pointer-events-none flex items-center justify-center'>
            <div style={{
              width: '78%', height: '78%', borderRadius: '50%',
              border: '3px solid rgba(255,255,255,0.6)',
              transition: 'border-color 0.2s',
            }} />
          </div>
        )}

        {/* Enroll progress dots */}
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

        {/* Blink indicator for verify */}
        {mode === 'verify' && status === 'capturing' && (
          <div className='absolute bottom-3 left-0 right-0 flex justify-center'>
            <span style={{
              fontSize: 11, fontWeight: 600, letterSpacing: '0.04em',
              color: blinkDone.current ? 'var(--green)' : 'rgba(255,255,255,0.7)',
              background: 'rgba(0,0,0,0.45)', borderRadius: 99, padding: '2px 10px',
            }}>
              {blinkDone.current ? '✓ blink detected' : 'blink once'}
            </span>
          </div>
        )}

        {/* Complete overlay */}
        {status === 'complete' && (
          <div className='absolute inset-0 flex items-center justify-center' style={{ background: 'rgba(0,0,0,0.45)' }}>
            <span style={{ fontSize: 48 }}>✓</span>
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
