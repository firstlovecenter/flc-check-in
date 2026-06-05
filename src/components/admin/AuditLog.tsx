import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import ScreenHeader from '../ScreenHeader'
import Spinner from '../Spinner'
import { PageShell, PageMain } from '../layout/PageShell'
import { Card, CardContent } from '../ui/card'
import { Alert } from '../ui/alert'
import { listAuditLogForEvent } from '../../utils/supabaseCheckins'
import { useEventEligibility } from '../../hooks/useEventEligibility'
import { useRefreshSignal } from '../../hooks/useRefreshSignal'
import { getCurrentUser } from '../../utils/auth'

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
      .then((all) => setEntries(all.filter((e) => e.action === 'checkin.manual')))
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
      <ScreenHeader title='Manual Check-in History' back={{ to: `/events/${eventId}`, label: 'Dashboard' }} />
      <PageMain className='max-w-2xl flex flex-col gap-4'>
        <p className='section-heading m-0'>{event.name}</p>

        {error && <Alert variant='destructive'>{error}</Alert>}

        {loading ? (
          <Spinner fullPage={false} />
        ) : entries.length === 0 ? (
          <p className='text-muted-foreground'>No manual check-ins yet.</p>
        ) : (
          <Card className='overflow-hidden p-0'>
            <CardContent className='p-0'>
              {entries.map((e, i) => {
                const ts = new Date(e.created_at)
                return (
                  <div
                    key={e.id}
                    className={`px-4 py-3 text-sm ${i < entries.length - 1 ? 'border-b border-border' : ''}`}
                  >
                    <p className='m-0 text-foreground'>
                      <span className='font-semibold'>{e.actor_name || e.actor_id}</span>
                      {' has manually checked-in '}
                      <span className='font-semibold text-primary'>{e.target_name || '—'}</span>
                      {' at '}
                      <span className='text-muted-foreground'>{format(ts, 'PPpp')}</span>
                    </p>
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
