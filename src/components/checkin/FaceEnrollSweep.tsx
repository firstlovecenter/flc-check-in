import { useEffect, useRef, useState } from 'react'
import {
  averageDescriptors,
  captureDescriptor,
  descriptorDistance,
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
  // 'top' | 'left' | 'right' | 'up' | 'down' relative to user view
  arrow: 'none' | 'left' | 'right' | 'up' | 'down'
  match: (yaw: number, pitch: number) => boolean
  // soft-progress signal: how strongly the current pose suggests this bucket
  // (0 = no movement that way, 1 = fully in the bucket). Used to glow the
  // upcoming wedge before it locks in.
  progress: (yaw: number, pitch: number) => number
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
    arrow: 'none',
    match: (y, p) => Math.abs(y) < YAW_OFF * 0.7 && Math.abs(p) < PITCH_OFF * 0.7,
    progress: (y, p) => clamp01(1 - Math.max(Math.abs(y) / YAW_OFF, Math.abs(p) / PITCH_OFF)),
  },
  {
    key: 'left',
    label: 'Slowly turn your head left',
    hint: 'Keep your eyes on the screen',
    arrow: 'left',
    match: (y) => y > YAW_OFF,
    progress: (y) => clamp01(y / YAW_OFF),
  },
  {
    key: 'right',
    label: 'Now turn your head right',
    hint: 'Keep your eyes on the screen',
    arrow: 'right',
    match: (y) => y < -YAW_OFF,
    progress: (y) => clamp01(-y / YAW_OFF),
  },
  {
    key: 'up',
    label: 'Now tilt your head up',
    hint: 'Lift your chin gently',
    arrow: 'up',
    match: (_y, p) => p > PITCH_OFF,
    progress: (_y, p) => clamp01(p / PITCH_OFF),
  },
  {
    key: 'down',
    label: 'Now tilt your head down',
    hint: 'Lower your chin gently',
    arrow: 'down',
    match: (_y, p) => p < -PITCH_OFF,
    progress: (_y, p) => clamp01(-p / PITCH_OFF),
  },
]

function clamp01(v: number) { return Math.min(1, Math.max(0, v)) }

const TICK_COUNT  = 30                                    // 30 ticks around the ring
const TICKS_PER_BUCKET = TICK_COUNT / BUCKETS.length      // 6 ticks per pose
const SAMPLE_INTERVAL = 180

type Status = 'idle' | 'loading-models' | 'starting-camera' | 'capturing' | 'complete' | 'error'

export default function FaceEnrollSweep({ onComplete, onError }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [filledCount, setFilledCount] = useState(0)            // number of buckets locked
  const [currentKey, setCurrentKey] = useState<BucketKey>('center')
  const [softProgress, setSoftProgress] = useState(0)          // 0..1 for current bucket
  const [message, setMessage] = useState('Loading face models...')
  // Quality score derived from mean pairwise descriptor distance after enrol.
  // Higher spread = better discriminability. 'good' | 'fair' | 'poor' | null
  const [quality, setQuality] = useState<'good' | 'fair' | 'poor' | null>(null)

  useEffect(() => {
    let stopped = false
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    const collected: Partial<Record<BucketKey, Float32Array>> = {}
    const filledLocal: Record<BucketKey, boolean> = {
      center: false, left: false, right: false, up: false, down: false,
    }

    function nextUnfilledIndex(): number {
      for (let i = 0; i < BUCKETS.length; i++) if (!filledLocal[BUCKETS[i].key]) return i
      return -1
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

        setStatus('capturing')
        const firstIdx = nextUnfilledIndex()
        if (firstIdx >= 0) {
          setCurrentKey(BUCKETS[firstIdx].key)
          setMessage(BUCKETS[firstIdx].label)
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
            const idx = nextUnfilledIndex()
            if (idx >= 0) {
              const b = BUCKETS[idx]
              setSoftProgress(b.progress(yaw, pitch))
              if (b.match(yaw, pitch)) {
                filledLocal[b.key] = true
                collected[b.key] = cap.descriptor
                setFilledCount(Object.values(filledLocal).filter(Boolean).length)
                setSoftProgress(0)

                const nextIdx = nextUnfilledIndex()
                if (nextIdx < 0) {
                  const descriptors = BUCKETS
                    .map((bb) => collected[bb.key])
                    .filter((d): d is Float32Array => !!d)
                  const avg = averageDescriptors(descriptors)

                  // Compute mean pairwise distance as a proxy for descriptor
                  // variance. A higher spread means the 5 pose samples are
                  // genuinely different — indicating good coverage.
                  if (descriptors.length >= 2) {
                    let sum = 0, n = 0
                    for (let i = 0; i < descriptors.length; i++) {
                      for (let j = i + 1; j < descriptors.length; j++) {
                        sum += descriptorDistance(descriptors[i], descriptors[j])
                        n++
                      }
                    }
                    const mean = n > 0 ? sum / n : 0
                    setQuality(mean < 0.35 ? 'good' : mean < 0.50 ? 'fair' : 'poor')
                  }

                  stopped = true
                  if (timer) clearTimeout(timer)
                  setStatus('complete')
                  setMessage('Face ID set up')
                  onComplete(avg)
                  return
                }
                setCurrentKey(BUCKETS[nextIdx].key)
                setMessage(BUCKETS[nextIdx].label)
              }
            }
          } else {
            setSoftProgress(0)
            setMessage('Keep your face in view')
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

  const currentBucket = BUCKETS.find((b) => b.key === currentKey)!

  return (
    <div className='flex flex-col gap-3 items-center'>
      <FaceRing
        videoRef={videoRef}
        status={status}
        filledCount={filledCount}
        softProgress={softProgress}
        arrow={currentBucket.arrow}
      />

      <div className='text-center' style={{ minHeight: '2.75rem', maxWidth: 320 }}>
        {status === 'capturing' && (
          <>
            <p className='text-sm m-0' style={{ color: 'var(--text)', fontWeight: 600 }}>
              {currentBucket.label}
            </p>
            <p className='text-xs m-0 mt-1' style={{ color: 'var(--muted)' }}>
              {currentBucket.hint}
            </p>
          </>
        )}
        {status === 'complete' && (
          <>
            <p className='text-sm m-0' style={{ color: 'var(--green)', fontWeight: 600 }}>
              {message}
            </p>
            {quality && (
              <p
                className='text-xs m-0 mt-1 font-semibold'
                style={{
                  color: quality === 'good' ? 'var(--green)' : quality === 'fair' ? 'var(--amber)' : 'var(--coral)',
                }}
              >
                Enrollment quality: {quality === 'good' ? '✓ Good' : quality === 'fair' ? '▲ Fair' : '⚠ Poor — consider re-enrolling'}
              </p>
            )}
          </>
        )}
        {status !== 'capturing' && status !== 'complete' && (
          <p className='text-sm m-0' style={{ color: status === 'error' ? 'var(--coral)' : 'var(--muted)' }}>
            {message}
          </p>
        )}
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
//  Visual ring: video framed in a circle, surrounded by a 30-tick progress
//  arc, with directional arrow + completion pulse. SVG over the video.
// ────────────────────────────────────────────────────────────────────────────

interface RingProps {
  videoRef: React.RefObject<HTMLVideoElement | null>
  status: Status
  filledCount: number
  softProgress: number
  arrow: Bucket['arrow']
}

function FaceRing({ videoRef, status, filledCount, softProgress, arrow }: RingProps) {
  const SIZE = 280
  const CENTER = SIZE / 2
  // Ring sits just outside the face oval. Inner radius leaves room for the
  // ticks; tick endpoints reach further out.
  const TICK_INNER = 130
  const TICK_OUTER = 142
  const TICK_OUTER_ACTIVE = 146  // active ticks reach slightly further for the lit-up effect

  const filledTicks = filledCount * TICKS_PER_BUCKET
  const softTicks = softProgress * TICKS_PER_BUCKET
  const isComplete = status === 'complete'

  return (
    <div
      className='relative'
      style={{ width: SIZE, height: SIZE }}
    >
      <style>{`
        @keyframes faceRingShimmer {
          0%, 100% { opacity: 0.35; }
          50%      { opacity: 0.75; }
        }
        @keyframes faceRingArrowDriftLeft  { 0%,100%{transform:translateX(0)} 50%{transform:translateX(-8px)} }
        @keyframes faceRingArrowDriftRight { 0%,100%{transform:translateX(0)} 50%{transform:translateX(8px)}  }
        @keyframes faceRingArrowDriftUp    { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-8px)} }
        @keyframes faceRingArrowDriftDown  { 0%,100%{transform:translateY(0)} 50%{transform:translateY(8px)}  }
        @keyframes faceRingComplete {
          0%   { transform: scale(1); opacity: 1; }
          40%  { transform: scale(1.06); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
        @keyframes faceRingGlow {
          0%   { opacity: 0; transform: scale(0.85); }
          60%  { opacity: 0.45; }
          100% { opacity: 0; transform: scale(1.4); }
        }
        @keyframes faceRingCheckIn {
          0%   { opacity: 0; transform: scale(0.6); }
          100% { opacity: 1; transform: scale(1); }
        }
        @keyframes faceRingSpin {
          to { transform: rotate(360deg); }
        }
      `}</style>

      {/* Circular video crop */}
      <div
        className='absolute overflow-hidden'
        style={{
          left: CENTER - TICK_INNER + 8,
          top:  CENTER - TICK_INNER + 8,
          width:  (TICK_INNER - 8) * 2,
          height: (TICK_INNER - 8) * 2,
          borderRadius: '50%',
          background: 'rgba(0,0,0,0.85)',
          boxShadow: 'inset 0 0 40px rgba(0,0,0,0.6)',
        }}
      >
        <video
          ref={videoRef}
          className='w-full h-full object-cover'
          style={{ transform: 'scaleX(-1)' }}
          muted
          playsInline
        />

        {(status === 'idle' || status === 'loading-models' || status === 'starting-camera') && (
          <div className='absolute inset-0 flex items-center justify-center' style={{ background: 'rgba(0,0,0,0.6)' }}>
            <div style={{
              width: 34, height: 34, borderRadius: '50%',
              border: '3px solid var(--text)',
              borderTopColor: 'transparent',
              animation: 'faceRingSpin 0.9s linear infinite',
            }} />
          </div>
        )}

        {isComplete && (
          <div
            className='absolute inset-0 flex items-center justify-center'
            style={{ background: 'rgba(46,203,143,0.18)', animation: 'faceRingCheckIn 0.45s ease-out both' }}
          >
            <svg width='80' height='80' viewBox='0 0 80 80'>
              <circle cx='40' cy='40' r='34' fill='none' stroke='var(--green)' strokeWidth='4' />
              <path d='M24 41 L36 53 L57 30' fill='none' stroke='var(--green)' strokeWidth='5' strokeLinecap='round' strokeLinejoin='round' />
            </svg>
          </div>
        )}
      </div>

      {/* Completion glow */}
      {isComplete && (
        <div
          className='absolute pointer-events-none'
          style={{
            inset: 0,
            borderRadius: '50%',
            boxShadow: '0 0 60px 8px rgba(46,203,143,0.55)',
            animation: 'faceRingGlow 0.9s ease-out both',
          }}
        />
      )}

      {/* SVG tick ring */}
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className='absolute inset-0 pointer-events-none'
        style={{
          animation: isComplete ? 'faceRingComplete 0.6s ease-out both' : undefined,
        }}
      >
        {Array.from({ length: TICK_COUNT }).map((_, i) => {
          // Start at the top (12 o'clock) and go clockwise.
          const angle = (i / TICK_COUNT) * Math.PI * 2 - Math.PI / 2
          const isFilled    = i < filledTicks
          const wedgeIdx    = i - filledTicks                       // 0..TICKS_PER_BUCKET-1 within active wedge
          const isActive    = !isFilled && wedgeIdx < TICKS_PER_BUCKET
          const softLit     = isActive && wedgeIdx < softTicks      // light up softly as user approaches the pose
          const outer       = (isFilled || softLit) ? TICK_OUTER_ACTIVE : TICK_OUTER
          const x1 = CENTER + Math.cos(angle) * TICK_INNER
          const y1 = CENTER + Math.sin(angle) * TICK_INNER
          const x2 = CENTER + Math.cos(angle) * outer
          const y2 = CENTER + Math.sin(angle) * outer

          let stroke = 'rgba(255,255,255,0.18)'
          let glow = 'none'
          let animation: string | undefined
          if (isFilled) {
            stroke = 'var(--green)'
            glow = 'drop-shadow(0 0 4px rgba(52,211,153,0.8))'
          } else if (softLit) {
            stroke = 'rgba(52,211,153,0.6)'
            glow = 'drop-shadow(0 0 3px rgba(52,211,153,0.45))'
          } else if (isActive) {
            stroke = 'rgba(243,240,238,0.55)'
            animation = `faceRingShimmer 1.6s ease-in-out ${wedgeIdx * 0.08}s infinite`
          }

          return (
            <line
              key={i}
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={stroke}
              strokeWidth={3}
              strokeLinecap='round'
              style={{ filter: glow, animation, transition: 'stroke 0.25s' }}
            />
          )
        })}
      </svg>

      {/* Directional arrow nudge */}
      {status === 'capturing' && arrow !== 'none' && (
        <DirectionalArrow size={SIZE} direction={arrow} />
      )}
    </div>
  )
}

function DirectionalArrow({ size, direction }: { size: number; direction: 'left' | 'right' | 'up' | 'down' }) {
  const half = size / 2
  let style: React.CSSProperties
  let chevron: React.ReactNode
  const stroke = 'rgba(243,240,238,0.75)'

  if (direction === 'left') {
    style = {
      position: 'absolute', left: -8, top: half - 14,
      animation: 'faceRingArrowDriftLeft 1.4s ease-in-out infinite',
    }
    chevron = (
      <svg width='28' height='28' viewBox='0 0 28 28'>
        <path d='M18 4 L8 14 L18 24' fill='none' stroke={stroke} strokeWidth='3' strokeLinecap='round' strokeLinejoin='round' />
      </svg>
    )
  } else if (direction === 'right') {
    style = {
      position: 'absolute', right: -8, top: half - 14,
      animation: 'faceRingArrowDriftRight 1.4s ease-in-out infinite',
    }
    chevron = (
      <svg width='28' height='28' viewBox='0 0 28 28'>
        <path d='M10 4 L20 14 L10 24' fill='none' stroke={stroke} strokeWidth='3' strokeLinecap='round' strokeLinejoin='round' />
      </svg>
    )
  } else if (direction === 'up') {
    style = {
      position: 'absolute', top: -8, left: half - 14,
      animation: 'faceRingArrowDriftUp 1.4s ease-in-out infinite',
    }
    chevron = (
      <svg width='28' height='28' viewBox='0 0 28 28'>
        <path d='M4 18 L14 8 L24 18' fill='none' stroke={stroke} strokeWidth='3' strokeLinecap='round' strokeLinejoin='round' />
      </svg>
    )
  } else {
    style = {
      position: 'absolute', bottom: -8, left: half - 14,
      animation: 'faceRingArrowDriftDown 1.4s ease-in-out infinite',
    }
    chevron = (
      <svg width='28' height='28' viewBox='0 0 28 28'>
        <path d='M4 10 L14 20 L24 10' fill='none' stroke={stroke} strokeWidth='3' strokeLinecap='round' strokeLinejoin='round' />
      </svg>
    )
  }
  return <div style={style}>{chevron}</div>
}
