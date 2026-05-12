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

// Match threshold per face-api.js docs: <0.5 is high-confidence. We accept
// up to 0.55 to allow for lighting variance at venues.
const MATCH_THRESHOLD = 0.55

// Blink detection: EAR drops below CLOSED then recovers above OPEN.
const EAR_CLOSED = 0.20
const EAR_OPEN   = 0.27

// Enrollment: collect this many good frames, then average their descriptors.
const ENROLL_FRAMES = 3

// Detection cadence (ms). 200ms ≈ 5fps — plenty for face matching, light on CPU.
const DETECT_INTERVAL = 200

type Status =
  | 'idle'
  | 'loading-models'
  | 'starting-camera'
  | 'ready'        // waiting for face
  | 'capturing'    // face visible; collecting frames / waiting for blink
  | 'complete'
  | 'error'

export default function FaceCapture({ mode, targetDescriptor, onComplete, onError }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState('Loading models…')
  const [progress, setProgress] = useState(0) // 0..1 for enroll progress, or 0..1 for "blink seen"

  useEffect(() => {
    let stopped = false
    let stream: MediaStream | null = null
    let detectTimer: ReturnType<typeof setTimeout> | null = null

    // Mode state
    const collected: Float32Array[] = []   // enroll: accumulated descriptors
    let blinkArmed = false                 // verify: have we seen eyes-open?
    let blinkSeen = false                  // verify: have we seen the closed→open transition?

    async function start() {
      try {
        setStatus('loading-models')
        setMessage('Loading face models…')
        await loadFaceModels()
        if (stopped) return

        setStatus('starting-camera')
        setMessage('Starting camera…')
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 480 } },
          audio: false,
        })
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop())
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
        setMessage(err.message || 'Camera error')
        onError?.(err)
      }
    }

    async function loop() {
      if (stopped || !videoRef.current) return
      const video = videoRef.current

      // Only process when we actually have video frames
      if (video.readyState >= 2 && video.videoWidth > 0) {
        try {
          const cap = await captureDescriptor(video)
          if (!stopped && cap) {
            handleFrame(cap.descriptor, eyeAspectRatio(cap.landmarks))
          } else if (!stopped) {
            setMessage(mode === 'enroll' ? 'Position your face in the circle' : 'Position your face in the circle')
          }
        } catch (_) {
          // ignore single-frame failures
        }
      }

      if (!stopped) {
        detectTimer = setTimeout(loop, DETECT_INTERVAL)
      }
    }

    function handleFrame(descriptor: Float32Array, ear: number) {
      if (mode === 'enroll') {
        // Collect descriptors on each successful frame. Stop after N.
        collected.push(descriptor)
        setStatus('capturing')
        setProgress(collected.length / ENROLL_FRAMES)
        setMessage(`Capturing ${collected.length} of ${ENROLL_FRAMES}…`)
        if (collected.length >= ENROLL_FRAMES) {
          finish(averageDescriptors(collected))
        }
        return
      }

      // verify mode: blink + match
      if (!targetDescriptor) return
      const dist = descriptorDistance(descriptor, targetDescriptor)

      // Track blink state machine: open → closed → open
      if (ear > EAR_OPEN) {
        if (!blinkArmed) blinkArmed = true
        else if (blinkArmed && progress === 1) {
          // already saw blink; stay armed
        }
      } else if (ear < EAR_CLOSED && blinkArmed) {
        blinkSeen = true // seen eyes closed after open; need to see open again to confirm
      }
      if (blinkSeen && ear > EAR_OPEN) {
        setProgress(1)
      }

      setStatus('capturing')
      if (dist > MATCH_THRESHOLD) {
        setMessage('Face does not match your profile')
        return
      }
      if (!blinkSeen || progress < 1) {
        setMessage('Match found — please blink once')
        return
      }
      // Match + blink confirmed
      finish(descriptor)
    }

    function finish(descriptor: Float32Array) {
      if (stopped) return
      stopped = true
      setStatus('complete')
      setMessage(mode === 'enroll' ? 'Enrollment captured' : 'Verified')
      onComplete(descriptor)
    }

    start()

    return () => {
      stopped = true
      if (detectTimer) clearTimeout(detectTimer)
      if (stream) stream.getTracks().forEach((t) => t.stop())
      if (videoRef.current) {
        try { videoRef.current.srcObject = null } catch { /* ignore */ }
      }
    }
  }, [mode, targetDescriptor, onComplete, onError])

  return (
    <div className='flex flex-col gap-3'>
      <div
        className='relative rounded-2xl overflow-hidden mx-auto'
        style={{ background: '#000', aspectRatio: '1 / 1', width: '100%', maxWidth: 360 }}
      >
        <video
          ref={videoRef}
          className='w-full h-full object-cover'
          style={{ transform: 'scaleX(-1)' }}
          muted
          playsInline
        />
        {/* Circular face guide */}
        <div
          className='absolute inset-0 pointer-events-none flex items-center justify-center'
        >
          <div
            style={{
              width: '78%',
              height: '78%',
              borderRadius: '50%',
              border: `3px solid ${status === 'complete' ? 'var(--green)' : 'rgba(255,255,255,0.55)'}`,
              transition: 'border-color 0.2s',
            }}
          />
        </div>
        {/* Progress dots for enroll */}
        {mode === 'enroll' && status === 'capturing' && (
          <div className='absolute bottom-3 left-0 right-0 flex justify-center gap-2'>
            {Array.from({ length: ENROLL_FRAMES }).map((_, i) => (
              <span
                key={i}
                style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: i < Math.round(progress * ENROLL_FRAMES) ? 'var(--green)' : 'rgba(255,255,255,0.4)',
                }}
              />
            ))}
          </div>
        )}
      </div>

      <p
        className='text-sm text-center m-0'
        style={{ color: status === 'error' ? 'var(--coral)' : 'var(--muted)' }}
      >
        {message}
      </p>
    </div>
  )
}
