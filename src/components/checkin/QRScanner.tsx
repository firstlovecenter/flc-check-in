import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

// Decodes QR codes from the rear camera. Prefers the native BarcodeDetector
// API (Chrome/Edge/Android — zero JS download, hardware accelerated) and
// falls back to a QR-only zxing reader elsewhere (iOS Safari, Firefox).
// The fallback is a dynamic import so the zxing bundle is only fetched on
// browsers without native support, and only once the scanner is opened.

interface NativeDetector {
  detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>
}

async function createNativeDetector(): Promise<NativeDetector | null> {
  const BarcodeDetector = (window as any).BarcodeDetector
  if (!BarcodeDetector) return null
  try {
    const formats: string[] = (await BarcodeDetector.getSupportedFormats?.()) ?? []
    if (!formats.includes('qr_code')) return null
    return new BarcodeDetector({ formats: ['qr_code'] })
  } catch {
    return null
  }
}

export default function QRScanner({ onDecode, onError }) {
  const { t } = useTranslation()
  const videoRef = useRef(null)
  const [error, setError] = useState(null)
  const onDecodeRef = useRef(onDecode)
  const onErrorRef = useRef(onError)

  useEffect(() => { onDecodeRef.current = onDecode }, [onDecode])
  useEffect(() => { onErrorRef.current = onError }, [onError])

  useEffect(() => {
    let stopped = false
    let controls = null
    let stream: MediaStream | null = null
    let rafId = 0
    ;(async () => {
      try {
        // Explicitly request the rear-facing camera. Letting
        // decodeFromVideoDevice pick (deviceId=undefined) lands on the front
        // camera on iOS Safari, so the user films themselves and nothing
        // decodes. `ideal` (not `exact`) keeps desktops/laptops working
        // where only a front camera exists.
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        })
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        await video.play().catch(() => {/* autoplay may need a gesture; ignore */})

        const native = await createNativeDetector()
        if (native) {
          // Poll frames via rAF; `busy` guards against overlapping detect()
          // calls when a frame takes longer than 16ms to analyse.
          let busy = false
          const tick = () => {
            if (stopped) return
            if (!busy && video.readyState >= 2) {
              busy = true
              native.detect(video)
                .then((codes) => {
                  const text = codes[0]?.rawValue
                  if (text && !stopped) onDecodeRef.current?.(text)
                })
                .catch(() => {/* per-frame decode failures are normal */})
                .finally(() => { busy = false })
            }
            rafId = requestAnimationFrame(tick)
          }
          rafId = requestAnimationFrame(tick)
        } else {
          const { BrowserQRCodeReader } = await import('@zxing/browser')
          if (stopped) return
          const reader = new BrowserQRCodeReader()
          controls = await reader.decodeFromVideoElement(video, (result, err) => {
            if (stopped) return
            if (result) {
              onDecodeRef.current?.(result.getText())
            } else if (err && err.name !== 'NotFoundException') {
              // NotFoundException is normal — emitted on every frame with no QR
              // Anything else is worth surfacing.
              onErrorRef.current?.(err)
            }
          })
        }
      } catch (e: any) {
        setError(e.message)
        onErrorRef.current?.(e)
      }
    })()
    return () => {
      stopped = true
      cancelAnimationFrame(rafId)
      try { controls?.stop?.() } catch (_) { /* ignore */ }
      try {
        if (stream) stream.getTracks().forEach((t) => t.stop())
        const elStream = videoRef.current?.srcObject as MediaStream | null
        if (elStream && elStream !== stream) elStream.getTracks?.().forEach((t) => t.stop())
      } catch (_) { /* ignore */ }
    }
  }, [])

  if (error) {
    return (
      <div className='rounded-xl border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive'>
        {t('checkin.qr.cameraError', { error })}
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
