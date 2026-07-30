import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getCurrentPosition, pointInGeofence } from '../../utils/geo'
import { submitManualCheckIn, addAuditLog } from '../../utils/supabaseCheckins'
import { getCurrentUser, formatName } from '../../utils/auth'
import { Modal } from '../ui/modal'
import { Alert } from '../ui/alert'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'
import { Button } from '../ui/button'
import type { CheckinEventRow, MemberProfileRow, CheckinRecordRow, LatLng } from '../../types/app'

interface Props {
  event: CheckinEventRow
  member: MemberProfileRow
  onClose: () => void
  onSuccess?: (record: CheckinRecordRow) => void
}

export default function ManualCheckInModal({ event, member, onClose, onSuccess }: Props) {
  const { t } = useTranslation()
  const [reason, setReason] = useState('')
  const [position, setPosition] = useState<LatLng | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const admin = getCurrentUser()

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const pos = await getCurrentPosition({ timeout: 15000 })
        if (cancelled) return
        if (!pointInGeofence({ lat: pos.lat, lng: pos.lng }, event)) {
          setError(t('checkin.manual.outsideVenueAdmin'))
        }
        setPosition(pos)
      } catch (err: any) {
        if (!cancelled) setError(err.message)
      }
    })()
    return () => { cancelled = true }
  }, [event, t])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!position) return
    if (!pointInGeofence({ lat: position.lat, lng: position.lng }, event)) {
      setError(t('checkin.manual.outsideVenue'))
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const result = await submitManualCheckIn({
        eventId: event.id,
        admin: { id: admin.userId, name: formatName(admin) },
        member: {
          id: member.id,
          name: [member.first_name, member.last_name].filter(Boolean).join(' ') || member.id,
          role: (member.roles || [])[0] || null,
          unitName:
            member.bacenta_name ||
            member.governorship_name ||
            member.council_name ||
            member.stream_name ||
            null,
        },
        lat: position.lat,
        lng: position.lng,
        reason: reason.trim(),
        event,
      })
      if (result.ok) {
        addAuditLog({
          action: 'checkin.manual',
          actorId: admin.userId,
          actorName: formatName(admin),
          eventId: event.id,
          targetId: member.id,
          targetName: [member.first_name, member.last_name].filter(Boolean).join(' ') || member.id,
          details: reason.trim() ? { reason: reason.trim() } : undefined,
        }).catch(() => {})
        onSuccess?.(result.record)
      } else setError(result.reason || t('checkin.manual.failed'))
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal open onClose={onClose}>
      <form onSubmit={handleSubmit} className='flex flex-col gap-4'>
        <div>
          <h2 className='m-0 text-lg font-semibold text-foreground'>{t('checkin.manual.title')}</h2>
          <p className='m-0 mt-1 text-xs text-muted-foreground'>
            {[member.first_name, member.last_name].filter(Boolean).join(' ')} · {member.bacenta_name || '—'}
          </p>
        </div>
        <div>
          <Label className='text-xs font-bold uppercase tracking-widest'>{t('checkin.manual.reasonLabel')}</Label>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder={t('checkin.manual.reasonPlaceholder')}
            className='mt-1.5 min-h-0'
          />
        </div>
        {error && <Alert variant='destructive'>{error}</Alert>}
        <div className='flex gap-2'>
          <Button type='button' variant='outline' onClick={onClose} className='flex-1'>
            {t('checkin.manual.cancel')}
          </Button>
          <Button type='submit' disabled={submitting || !position || !!error} className='flex-1'>
            {submitting ? t('checkin.manual.checkingIn') : t('checkin.manual.submit')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
