import { useEffect, useState } from 'react'
import ScreenHeader from '../ScreenHeader'
import Papa from 'papaparse'
import { format } from 'date-fns'
import {
  listEventsForAdminScopes,
  listCheckedIn,
  getEvent,
  bulkUpsertMemberProfiles,
} from '../../utils/supabaseCheckins'
import { getCurrentUser } from '../../utils/auth'
import { getMembersInScope, memberToProfileRow } from '../../utils/membersApi'
import { useRefreshSignal } from '../../hooks/useRefreshSignal'
import { PageShell, PageMain } from '../layout/PageShell'
import { CenterCard } from '../layout/CenterCard'
import { Card, CardContent } from '../ui/card'
import { Button } from '../ui/button'
import { EmptyState } from '../layout/EmptyState'

export default function ReportsList() {
  const user = getCurrentUser()
  const [events, setEvents] = useState<any[]>([])
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  useRefreshSignal(() => setRefreshKey((k) => k + 1))

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const ownLevel = user?.level
        const ownId = ownLevel ? (user as any)[ownLevel]?.id : null
        const scopes = ownLevel && ownId ? [{ level: ownLevel, id: ownId }] : []
        const evs = await listEventsForAdminScopes(scopes, { user })
        if (!cancelled) setEvents(evs)
      } catch (err: any) {
        if (!cancelled) setError(err.message)
      }
    })()
    return () => { cancelled = true }
  }, [user?.userId, refreshKey])

  async function handleDownload(eventId: string) {
    try {
      const evt = await getEvent(eventId)
      const members = await getMembersInScope({ level: evt.scope_level, churchId: evt.scope_church_id })
      const rows = members.map(memberToProfileRow)
      await bulkUpsertMemberProfiles(rows)
      const recs = await listCheckedIn(eventId)
      const recordByMember = new Map(recs.map((r) => [r.member_id, r]))
      const csvRows = rows.map((m) => {
        const r = recordByMember.get(m.id)
        const status = !r ? 'Defaulted' : r.checked_out_at ? 'Checked Out' : 'Checked In'
        return {
          Name: [m.first_name, m.last_name].filter(Boolean).join(' '),
          Role: (m.roles || [])[0] || '',
          Unit: m.bacenta_name || m.governorship_name || m.council_name || m.stream_name || '',
          Status: status,
          'Checked In At': r?.checked_in_at
            ? format(new Date(r.checked_in_at), 'yyyy-MM-dd HH:mm:ss')
            : '',
          'Checked Out At': r?.checked_out_at
            ? format(new Date(r.checked_out_at), 'yyyy-MM-dd HH:mm:ss')
            : '',
          'Auto Checked Out': r?.checked_out_at ? (r.auto_checked_out ? 'Yes' : 'No') : '',
          Method: r?.method || '',
          'Is Late': r ? (r.is_late ? 'Yes' : 'No') : '',
          'Geo Verified': r ? (r.geo_verified ? 'Yes' : 'No') : '',
        }
      })
      const csv = Papa.unparse(csvRows)
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const safeName = evt.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
      a.href = url
      a.download = `${safeName}-${format(new Date(evt.starts_at), 'yyyy-MM-dd')}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err: any) {
      alert(err.message || 'Export failed')
    }
  }

  if (error) {
    return (
      <CenterCard>
        <p className='text-destructive'>{error}</p>
      </CenterCard>
    )
  }

  const filteredEvents = events.filter((evt) => {
    const s = search.trim().toLowerCase()
    if (!s) return true
    return [evt.name, evt.scope_church_name, evt.scope_level, evt.status]
      .some((v) => (v || '').toLowerCase().includes(s))
  })

  return (
    <PageShell>
      <ScreenHeader
        title='Reports'
        right={<span className='text-xs text-muted-foreground'>{filteredEvents.length}</span>}
      />
      <PageMain className='flex flex-col gap-3'>
        <input
          type='search'
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder='Search events…'
          className='input-field'
        />
        {filteredEvents.length === 0 && (
          <EmptyState
            title={search ? 'No matches' : 'No events yet'}
            description={search ? 'Try a different search term.' : 'Reports will appear when events exist in your scope.'}
          />
        )}
        <div className='grid grid-cols-1 gap-3 md:grid-cols-2'>
          {filteredEvents.map((evt) => (
            <Card key={evt.id}>
              <CardContent className='p-0'>
                <div className='flex items-center justify-between gap-3 p-4'>
                  <button
                    type='button'
                    onClick={() => setExpanded(expanded === evt.id ? null : evt.id)}
                    className='min-w-0 flex-1 cursor-pointer border-0 bg-transparent p-0 text-left text-foreground'
                  >
                    <p className='m-0 truncate text-sm font-semibold'>{evt.name}</p>
                    <p className='m-0 mt-0.5 truncate text-xs text-muted-foreground'>
                      {evt.scope_level} · {evt.scope_church_name} · {evt.status}
                    </p>
                  </button>
                  <Button type='button' variant='outline' size='sm' onClick={() => handleDownload(evt.id)}>
                    Download CSV
                  </Button>
                </div>
                {expanded === evt.id && (
                  <div className='space-y-1 px-4 pb-4 text-xs text-muted-foreground'>
                    <p>Starts: {format(new Date(evt.starts_at), 'PP HH:mm')}</p>
                    <p>Ends: {format(new Date(evt.ends_at), 'PP HH:mm')}</p>
                    <p>Grace: {evt.grace_period_min} min</p>
                    <p>Methods: {(evt.allowed_check_in_methods || []).join(', ')}</p>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </PageMain>
    </PageShell>
  )
}
