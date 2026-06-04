import { useEffect, useState } from 'react'
import { formatDistanceToNowStrict, format } from 'date-fns'
import ScreenHeader from '../ScreenHeader'
import Spinner from '../Spinner'
import { PageShell, PageMain } from '../layout/PageShell'
import { Card, CardContent } from '../ui/card'
import { Alert } from '../ui/alert'
import { Badge } from '../ui/badge'
import { listAuditLogForEvent } from '../../utils/supabaseCheckins'
import { useEventEligibility } from '../../hooks/useEventEligibility'
import { useRefreshSignal } from '../../hooks/useRefreshSignal'
import { getCurrentUser } from '../../utils/auth'

const ACTION_META: Record<string, { label: string; className: string }> = {
  'event.pause': { label: 'Paused', className: 'bg-warning/15 text-warning border-warning/30' },
  'event.resume': { label: 'Resumed', className: 'bg-success/15 text-success border-success/30' },
  'event.end': { label: 'Ended', className: 'bg-muted text-muted-foreground border-border' },
  'event.extend': { label: 'Extended', className: 'bg-primary/15 text-primary border-primary/30' },
  'event.update': { label: 'Updated', className: 'bg-primary/15 text-primary border-primary/30' },
  'checkin.manual': { label: 'Manual Check-in', className: 'bg-success/15 text-success border-success/30' },
  'face.descriptor_clear': { label: 'Face ID Reset', className: 'bg-destructive/15 text-destructive border-destructive/30' },
  'pin.reset': { label: 'PIN Reset', className: 'bg-warning/15 text-warning border-warning/30' },
  'absence.note_set': { label: 'Absence Note', className: 'bg-secondary text-foreground border-border' },
}

export default function AuditLog({ eventId }: { eventId: string }) {
  const user = getCurrentUser()
  const [refreshKey, setRefreshKey] = useState(0)
  useRefreshSignal(() => setRefreshKey((k) => k + 1))
  const { event, viewerCaps, initialLoading } = useEventEligibility(eventId, user, { refreshKey })
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
  }, [eventId, refreshKey])

  if (initialLoading || !event) return <Spinner fullPage />

  if (viewerCaps && !viewerCaps.canManage) {
    return (
      <PageShell className='items-center justify-center'>
        <p className='text-muted-foreground'>Admin access required.</p>
      </PageShell>
    )
  }

  return (
    <PageShell>
      <ScreenHeader title='Audit Log' back={{ to: `/events/${eventId}`, label: 'Dashboard' }} />
      <PageMain className='max-w-2xl flex flex-col gap-4'>
        <p className='section-heading m-0'>{event.name}</p>

        {error && <Alert variant='destructive'>{error}</Alert>}

        {loading ? (
          <Spinner fullPage={false} />
        ) : entries.length === 0 ? (
          <p className='text-muted-foreground'>No audit entries yet.</p>
        ) : (
          <Card className='overflow-hidden p-0'>
            <CardContent className='p-0'>
              {entries.map((e, i) => {
                const meta = ACTION_META[e.action] || {
                  label: e.action,
                  className: 'bg-secondary text-foreground border-border',
                }
                const ts = new Date(e.created_at)
                return (
                  <div
                    key={e.id}
                    className={`list-row flex flex-col gap-0.5 px-4 py-3 ${i < entries.length - 1 ? 'border-b border-border' : ''}`}
                  >
                    <div className='flex items-center justify-between gap-2'>
                      <Badge className={`border text-[10px] ${meta.className}`}>{meta.label}</Badge>
                      <span className='tnum shrink-0 text-xs text-muted-foreground'>
                        {formatDistanceToNowStrict(ts, { addSuffix: true })}
                      </span>
                    </div>
                    <p className='m-0 text-xs text-foreground'>
                      <span className='font-semibold'>{e.actor_name || e.actor_id}</span>
                      {e.target_name ? (
                        <>
                          {' '}
                          → <span className='text-primary'>{e.target_name}</span>
                        </>
                      ) : null}
                    </p>
                    {e.details && Object.keys(e.details).length > 0 && (
                      <p className='m-0 text-xs text-muted-foreground'>
                        {Object.entries(e.details)
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(' · ')}
                      </p>
                    )}
                    <p className='m-0 text-[10px] opacity-60 text-muted-foreground'>{format(ts, 'PPpp')}</p>
                  </div>
                )
              })}
            </CardContent>
          </Card>
        )}
      </PageMain>
    </PageShell>
  )
}
