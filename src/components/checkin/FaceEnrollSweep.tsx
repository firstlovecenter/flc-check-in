import { useEffect, useRef, useState } from 'react'
import {
  averageDescriptors,
  captureDescriptor,
  estimateHeadPose,
  loadFaceModels,
} from '../../utils/faceApi'

interface Props {
  onComplete: (descriptor: Float32Array) => void
  onError?: (err: Error) => void
}

type BucketKey = 'center' | 'left' | 'right' | 'up' | 'down'

interface Bucket {
  key: BucketKey
  label: string
  hint: string
  match: (yaw: number, pitch: number) => boolean
}

// Yaw/pitch thresholds. Values come from estimateHeadPose (normalised
// by face geometry). The video is mirrored in the UI — for the *user*,
// turning their head to their own left makes the raw nose.x move to
// the right of the eye midpoint (positive yaw). We label buckets from
// the user's perspective, so "left" matches positive yaw.
const YAW_OFF   = 0.14
const PITCH_OFF = 0.08

const BUCKETS: Bucket[] = [
  {
    key: 'center',
    label: 'Look straight ahead',
    hint: 'Face the camera',
    match: (y, p) => Math.abs(y) < YAW_OFF * 0.7 && Math.abs(p) < PITCH_OFF * 0.7,
  },
  {
    key: 'left',
    label: 'Slowly turn your head left',
    hint: 'Keep your eyes on the screen',
    match: (y) => y > YAW_OFF,
  },
  {
    key: 'right',
    label: 'Now turn your head right',
    hint: 'Keep your eyes on the screen',
    match: (y) => y < -YAW_OFF,
  },
  {
    key: 'up',
    label: 'Now tilt your head up',
    hint: 'Lift your chin gently',
    match: (_y, p) => p > PITCH_OFF,
  },
  {
    key: 'down',
    label: 'Now tilt your head down',
    hint: 'Lower your chin gently',
    match: (_y, p) => p < -PITCH_OFF,
  },
]

const SAMPLE_INTERVAL = 180

type Status = 'idle' | 'loading-models' | 'starting-camera' | 'capturing' | 'complete' | 'error'

export default function FaceEnrollSweep({ onComplete, onError }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [filled, setFilled] = useState<Record<BucketKey, boolean>>({
    center: false, left: false, right: false, up: false, down: false,
  })
  const [currentKey, setCurrentKey] = useState<BucketKey>('center')
  const [message, setMessage] = useState('Loading face models...')

  useEffect(() => {
    let stopped = false
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    const collected: Partial<Record<BucketKey, Float32Array>> = {}
    const filledLocal: Record<BucketKey, boolean> = {
      center: false, left: false, right: false, up: false, down: false,
    }

    function nextUnfilled(): BucketKey | null {
      for (const b of BUCKETS) if (!filledLocal[b.key]) return b.key
      return null
    }

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
          stream.getTracks().forEach((t) => t.stop())
          return
        }

        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play().catch(() => {})
        }

        setStatus('capturing')
        const first = nextUnfilled()
        if (first) {
          setCurrentKey(first)
          setMessage(BUCKETS.find((b) => b.key === first)!.label)
        }
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
            const { yaw, pitch } = estimateHeadPose(cap.landmarks)
            for (const b of BUCKETS) {
              if (!filledLocal[b.key] && b.match(yaw, pitch)) {
                filledLocal[b.key] = true
                collected[b.key] = cap.descriptor
                setFilled({ ...filledLocal })
                break
              }
            }

            const next = nextUnfilled()
            if (!next) {
              const descriptors = BUCKETS
                .map((b) => collected[b.key])
                .filter((d): d is Float32Array => !!d)
              const avg = averageDescriptors(descriptors)
              stopped = true
              if (timer) clearTimeout(timer)
              setStatus('complete')
              setMessage('Enrollment captured!')
              onComplete(avg)
              return
            }

            setCurrentKey(next)
            setMessage(BUCKETS.find((b) => b.key === next)!.label)
          } else {
            setMessage('Keep your face in the circle')
          }
        } catch (_) {
          // single-frame detection failures are non-fatal
        }
      }

      if (!stopped) timer = setTimeout(loop, SAMPLE_INTERVAL)
    }

    start()

    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      stream?.getTracks().forEach((t) => t.stop())
      if (videoRef.current) {
        try { videoRef.current.srcObject = null } catch { /* ignore */ }
      }
    }
  }, [onComplete, onError])

  const totalFilled = Object.values(filled).filter(Boolean).length
  const currentBucket = BUCKETS.find((b) => b.key === currentKey)!

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

        {status === 'capturing' && (
          <div className='absolute inset-0 pointer-events-none flex items-center justify-center'>
            <div style={{
              width: '78%', height: '78%', borderRadius: '50%',
              border: '3px solid rgba(255,255,255,0.6)',
            }} />
          </div>
        )}

        {status === 'capturing' && (
          <div className='absolute bottom-3 left-0 right-0 flex justify-center gap-2'>
            {BUCKETS.map((b) => (
              <span
                key={b.key}
                title={b.key}
                style={{
                  width: 10, height: 10, borderRadius: '50%',
                  background: filled[b.key]
                    ? 'var(--green)'
                    : b.key === currentKey
                      ? 'var(--accent)'
                      : 'rgba(255,255,255,0.35)',
                  transition: 'background 0.2s',
                }}
              />
            ))}
          </div>
        )}

        {status === 'complete' && (
          <div className='absolute inset-0 flex items-center justify-center' style={{ background: 'rgba(0,0,0,0.45)' }}>
            <span style={{ fontSize: 48 }}>OK</span>
          </div>
        )}
      </div>

      <div className='text-center' style={{ minHeight: '2.75rem' }}>
        {status === 'capturing' && (
          <>
            <p className='text-sm m-0' style={{ color: 'var(--text)', fontWeight: 600 }}>
              {currentBucket.label}
            </p>
            <p className='text-xs m-0 mt-1' style={{ color: 'var(--muted)' }}>
              {currentBucket.hint} · {totalFilled} of {BUCKETS.length}
            </p>
          </>
        )}
        {status !== 'capturing' && (
          <p className='text-sm m-0' style={{ color: status === 'error' ? 'var(--coral)' : 'var(--muted)' }}>
            {message}
          </p>
        )}
      </div>
    </div>
  )
}
