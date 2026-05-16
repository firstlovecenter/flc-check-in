import { useEffect, useRef } from 'react'
import QRCode from 'qrcode'

export default function QRCodeDisplay({ value, size = 280 }) {
  const canvasRef = useRef(null)
  useEffect(() => {
    if (!canvasRef.current || !value) return
    QRCode.toCanvas(canvasRef.current, value, {
      width: size,
      margin: 2,
      color: { dark: '#0C0F1A', light: '#FFFFFF' },
    })
  }, [value, size])
  return (
    <div className='inline-block max-w-full rounded-2xl p-3' style={{ background: '#fff' }}>
      <canvas ref={canvasRef} style={{ maxWidth: '100%', height: 'auto', display: 'block' }} />
    </div>
  )
}
