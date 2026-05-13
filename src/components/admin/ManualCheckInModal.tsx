import { useEffect, useState } from 'react'
import { getCurrentPosition, pointInGeofence } from '../../utils/geo'
import { submitManualCheckIn, addAuditLog } from '../../utils/supabaseCheckins'
import { getCurrentUser } from '../../utils/auth'
import type { CheckinEventRow, MemberProfileRow, CheckinRecordRow, LatLng } from '../../types/app'

interface Props {
  event: CheckinEventRow
  member: MemberProfileRow
  onClose: () => void
  onSuccess?: (record: CheckinRecordRow) => void
}

export default function ManualCheckInModal({ event, member, onClose, onSuccess }: Props) {
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
          setError('You are outside the venue area — admins must be on-site to manual check-in.')
        }
        setPosition(pos)
      } catch (err: any) {
        if (!cancelled) setError(err.message)
      }
    })()
    return () => { cancelled = true }
  }, [event])

  async function handleSubmit(e) {
    e.preventDefault()
    if (!position) return
    if (!pointInGeofence({ lat: position.lat, lng: position.lng }, event)) {
      setError('You are outside the venue area.'); return
    }
    setSubmitting(true)
    setError(null)
    try {
      const result = await submitManualCheckIn({
        eventId: event.id,
        admin: { id: admin.userId, name: `${admin.firstName} ${admin.lastName}`.trim() },
        member: {
          id: member.id,
          name: [member.first_name, member.last_name].filter(Boolean).join(' ') || member.id,
          role: (member.roles || [])[0] || null,
          unitName: member.bacenta_name || member.governorship_name || member.council_name || member.stream_name || null,
        },
        lat: position.lat, lng: position.lng,
        reason: reason.trim(),
        event,
      })
      if (result.ok) {
        addAuditLog({
          action: 'checkin.manual',
          actorId: admin.userId,
          actorName: `${admin.firstName} ${admin.lastName}`.trim(),
          eventId: event.id,
          targetId: member.id,
          targetName: [member.first_name, member.last_name].filter(Boolean).join(' ') || member.id,
          details: reason.trim() ? { reason: reason.trim() } : undefined,
        }).catch(() => {})
        onSuccess?.(result.record)
      } else setError(result.reason || 'Manual check-in failed')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center px-4'
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}>
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className='w-full max-w-md p-6 flex flex-col gap-4'
        style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-card)', boxShadow: 'var(--shadow-3)' }}
      >
        <div>
          <h2 className='text-lg font-semibold m-0' style={{ color: 'var(--text)' }}>Manual check-in</h2>
          <p className='text-xs m-0 mt-1' style={{ color: 'var(--muted)' }}>
            {[member.first_name, member.last_name].filter(Boolean).join(' ')} · {member.bacenta_name || '—'}
          </p>
        </div>
        <div>
          <label className='text-xs font-bold tracking-widest uppercase' style={{ color: 'var(--muted)' }}>
            Reason (optional)
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder='e.g. Phone not working, arrived late…'
            className='input-field mt-1.5'
          />
        </div>
        {error && (
          <p
            className='text-sm px-3 py-2 text-center'
            style={{ color: 'var(--coral)', background: 'rgba(232,96,74,0.1)', border: '1px solid rgba(232,96,74,0.2)', borderRadius: 'var(--radius-btn)' }}
          >
            {error}
          </p>
        )}
        <div className='flex gap-2'>
          <button
            type='button'
            onClick={onClose}
            className='btn-pill btn-secondary flex-1 py-2.5 text-sm font-semibold cursor-pointer'
          >
            Cancel
          </button>
          <button
            type='submit'
            disabled={submitting || !position || !!error}
            className='btn-pill btn-primary flex-1 py-2.5 text-sm font-semibold cursor-pointer disabled:opacity-50'
          >
            {submitting ? 'Checking in…' : 'Check in'}
          </button>
        </div>
      </form>
    </div>
  )
}
