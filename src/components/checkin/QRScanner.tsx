import { useEffect, useRef, useState } from 'react'
import { BrowserMultiFormatReader } from '@zxing/browser'

export default function QRScanner({ onDecode, onError }) {
  const videoRef = useRef(null)
  const [error, setError] = useState(null)
  const onDecodeRef = useRef(onDecode)
  const onErrorRef = useRef(onError)

  useEffect(() => { onDecodeRef.current = onDecode }, [onDecode])
  useEffect(() => { onErrorRef.current = onError }, [onError])

  useEffect(() => {
    const reader = new BrowserMultiFormatReader()
    let stopped = false
    let controls = null
    ;(async () => {
      try {
        controls = await reader.decodeFromVideoDevice(undefined, videoRef.current, (result, err) => {
          if (stopped) return
          if (result) {
            onDecodeRef.current?.(result.getText())
          } else if (err && err.name !== 'NotFoundException') {
            // NotFoundException is normal — emitted on every frame with no QR
            // Anything else is worth surfacing.
            onErrorRef.current?.(err)
          }
        })
      } catch (e: any) {
        setError(e.message)
        onErrorRef.current?.(e)
      }
    })()
    return () => {
      stopped = true
      try { controls?.stop?.() } catch (_) { /* ignore */ }
      try {
        const stream = videoRef.current?.srcObject
        if (stream) stream.getTracks?.().forEach((t) => t.stop())
      } catch (_) { /* ignore */ }
    }
  }, [])

  if (error) {
    return (
      <div className='rounded-xl p-4 text-sm' style={{ background: 'rgba(248,112,96,0.1)', color: 'var(--coral)', border: '1px solid rgba(248,112,96,0.2)' }}>
        Camera error: {error}
      </div>
    )
  }
  return (
    <div className='relative rounded-2xl overflow-hidden' style={{ background: '#000', aspectRatio: '1 / 1' }}>
      <video ref={videoRef} className='w-full h-full object-cover' muted playsInline />
      <div className='absolute inset-8 border-2 rounded-2xl pointer-events-none' style={{ borderColor: 'rgba(255,255,255,0.5)' }} />
    </div>
  )
}
