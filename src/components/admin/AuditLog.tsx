import { useEffect, useState } from 'react'
import { formatDistanceToNowStrict, format } from 'date-fns'
import ScreenHeader from '../ScreenHeader'
import { listAuditLogForEvent } from '../../utils/supabaseCheckins'
import { useEventEligibility } from '../../hooks/useEventEligibility'
import { getCurrentUser } from '../../utils/auth'

const ACTION_META: Record<string, { label: string; color: string }> = {
  'event.pause':            { label: 'Paused',          color: 'var(--amber)'  },
  'event.resume':           { label: 'Resumed',         color: 'var(--green)'  },
  'event.end':              { label: 'Ended',            color: 'var(--muted)'  },
  'event.extend':           { label: 'Extended',         color: 'var(--accent)' },
  'event.update':           { label: 'Updated',          color: 'var(--accent)' },
  'checkin.manual':         { label: 'Manual Check-in',  color: 'var(--green)'  },
  'face.descriptor_clear':  { label: 'Face ID Reset',    color: 'var(--coral)'  },
  'pin.reset':              { label: 'PIN Reset',         color: 'var(--amber)'  },
  'absence.note_set':       { label: 'Absence Note',      color: 'var(--purple)' },
}

export default function AuditLog({ eventId }: { eventId: string }) {
  const user = getCurrentUser()
  const { event, viewerCaps, initialLoading } = useEventEligibility(eventId, user)
  const [entries, setEntries] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!eventId) return
    setLoading(true)
    listAuditLogForEvent(eventId)
      .then(setEntries)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [eventId])

  if (initialLoading || !event) {
    return (
      <div className='min-h-dvh flex items-center justify-center' style={{ background: 'var(--bg)' }}>
        <p style={{ color: 'var(--muted)' }}>Loading…</p>
      </div>
    )
  }

  if (viewerCaps && !viewerCaps.canManage) {
    return (
      <div className='min-h-dvh flex items-center justify-center' style={{ background: 'var(--bg)' }}>
        <p style={{ color: 'var(--muted)' }}>Admin access required.</p>
      </div>
    )
  }

  return (
    <div className='min-h-dvh flex flex-col' style={{ background: 'var(--bg)' }}>
      <ScreenHeader
        title='Audit Log'
        back={{ to: `/events/${eventId}`, label: 'Dashboard' }}
      />
      <main className='flex-1 w-full max-w-2xl mx-auto px-4 py-6 flex flex-col gap-4'>
        <p className='eyebrow m-0'>{event.name}</p>

        {error && (
          <p className='text-sm px-3 py-2' style={{ color: 'var(--coral)', background: 'rgba(232,96,74,0.08)', borderRadius: 'var(--radius-btn)', border: '1px solid rgba(232,96,74,0.2)' }}>
            {error}
          </p>
        )}

        {loading ? (
          <p style={{ color: 'var(--muted)' }}>Loading log…</p>
        ) : entries.length === 0 ? (
          <p style={{ color: 'var(--muted)' }}>No audit entries yet.</p>
        ) : (
          <div
            style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-card)' }}
          >
            {entries.map((e, i) => {
              const meta = ACTION_META[e.action] || { label: e.action, color: 'var(--text)' }
              const ts = new Date(e.created_at)
              return (
                <div
                  key={e.id}
                  className='px-4 py-3 flex flex-col gap-0.5'
                  style={{ borderBottom: i < entries.length - 1 ? '1px solid var(--border)' : 'none' }}
                >
                  <div className='flex items-center justify-between gap-2'>
                    <span
                      className='text-[10px] font-bold uppercase px-2 py-0.5'
                      style={{
                        background: `${meta.color}1a`,
                        color: meta.color,
                        border: `1px solid ${meta.color}33`,
                        borderRadius: 'var(--radius-pill)',
                        letterSpacing: '0.05em',
                      }}
                    >
                      {meta.label}
                    </span>
                    <span className='text-xs tabular-nums shrink-0' style={{ color: 'var(--muted)' }}>
                      {formatDistanceToNowStrict(ts, { addSuffix: true })}
                    </span>
                  </div>
                  <p className='text-xs m-0' style={{ color: 'var(--text)' }}>
                    <span style={{ fontWeight: 600 }}>{e.actor_name || e.actor_id}</span>
                    {e.target_name ? <> → <span style={{ color: 'var(--accent)' }}>{e.target_name}</span></> : null}
                  </p>
                  {e.details && Object.keys(e.details).length > 0 && (
                    <p className='text-xs m-0' style={{ color: 'var(--muted)' }}>
                      {Object.entries(e.details)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(' · ')}
                    </p>
                  )}
                  <p className='text-[10px] m-0' style={{ color: 'var(--muted)', opacity: 0.6 }}>
                    {format(ts, 'PPpp')}
                  </p>
                </div>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
