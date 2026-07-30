import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import { toast } from './Toast'

// Persistent banner while offline + a one-shot "back online" toast on
// reconnect. Mounted once in App.tsx so every screen gets it for free.
export default function OfflineBanner() {
  const { t } = useTranslation()
  const online = useOnlineStatus()
  const wasOffline = useRef(false)

  useEffect(() => {
    if (!online) {
      wasOffline.current = true
    } else if (wasOffline.current) {
      wasOffline.current = false
      toast(t('common.backOnline'), 'success')
    }
  }, [online, t])

  if (online) return null
  return (
    <div className='offline-banner' role='status'>
      {t('common.offlineBanner')}
    </div>
  )
}
