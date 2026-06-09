import { useEffect, useRef } from 'react'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import { toast } from './Toast'

// Persistent banner while offline + a one-shot "back online" toast on
// reconnect. Mounted once in App.tsx so every screen gets it for free.
export default function OfflineBanner() {
  const online = useOnlineStatus()
  const wasOffline = useRef(false)

  useEffect(() => {
    if (!online) {
      wasOffline.current = true
    } else if (wasOffline.current) {
      wasOffline.current = false
      toast('Back online', 'success')
    }
  }, [online])

  if (online) return null
  return (
    <div className='offline-banner' role='status'>
      You&apos;re offline — data may be stale and check-ins won&apos;t submit.
    </div>
  )
}
