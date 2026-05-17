import { useEffect, useState } from 'react'
import ScreenHeader from '../ScreenHeader'
import Papa from 'papaparse'
import { format } from 'date-fns'
import {
  listEventsForAdminScopes, listCheckedIn, getEvent, bulkUpsertMemberProfiles,
} from '../../utils/supabaseCheckins'
import { getCurrentUser } from '../../utils/auth'
import { getMembersInScope, memberToProfileRow } from '../../utils/membersApi'
import { useRefreshSignal } from '../../hooks/useRefreshSignal'

export default function ReportsList() {
  const user = getCurrentUser()
  const [events, setEvents] = useState([])
  const [error, setError] = useState(null)
  const [expanded, setExpanded] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0)
  useRefreshSignal(() => setRefreshKey((k) => k + 1))

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // Derive scope from user.level — consistent with the home screen filter.
        const ownLevel = user.level
        const ownId    = ownLevel ? (user as any)[ownLevel]?.id : null
        const scopes   = ownLevel && ownId ? [{ level: ownLevel, id: ownId }] : []
        const evs = await listEventsForAdminScopes(scopes)
        if (!cancelled) setEvents(evs)
      } catch (err: any) {
        if (!cancelled) setError(err.message)
      }
    })()
    return () => { cancelled = true }
  }, [user.userId, refreshKey])

  async function handleDownload(eventId) {
    try {
      const evt = await getEvent(eventId)
      const members = await getMembersInScope({ level: evt.scope_level, churchId: evt.scope_church_id })
      const rows = members.map(memberToProfileRow)
      await bulkUpsertMemberProfiles(rows)
      const recs = await listCheckedIn(eventId)
      const recordByMember = new Map(recs.map((r) => [r.member_id, r]))
      const csvRows = rows.map((m) => {
        const r = recordByMember.get(m.id)
        const status = !r ? 'Defaulted' : (r.checked_out_at ? 'Checked Out' : 'Checked In')
        return {
          Name: [m.first_name, m.last_name].filter(Boolean).join(' '),
          Role: (m.roles || [])[0] || '',
          Unit: m.bacenta_name || m.governorship_name || m.council_name || m.stream_name || '',
          Status: status,
          'Checked In At': r?.checked_in_at ? format(new Date(r.checked_in_at), 'yyyy-MM-dd HH:mm:ss') : '',
          'Checked Out At': r?.checked_out_at ? format(new Date(r.checked_out_at), 'yyyy-MM-dd HH:mm:ss') : '',
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
      a.href = url; a.download = `${safeName}-${format(new Date(evt.starts_at), 'yyyy-MM-dd')}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err: any) {
      alert(err.message || 'Export failed')
    }
  }

  if (error) return <CenterCard><p style={{ color: 'var(--coral)' }}>{error}</p></CenterCard>

  return (
    <div className='min-h-dvh' style={{ background: 'var(--bg)' }}>
      <ScreenHeader title='Reports' right={<span className='text-xs' style={{ color: 'var(--muted)' }}>{events.length}</span>} />
      <main className='max-w-5xl mx-auto px-4 sm:px-6 py-6 flex flex-col gap-3'>
        {events.length === 0 && (
          <p className='text-sm text-center' style={{ color: 'var(--muted)' }}>No events yet.</p>
        )}
        <div className='grid grid-cols-1 md:grid-cols-2 gap-3'>
        {events.map((evt) => (
          <div
            key={evt.id}
            style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-btn)' }}
          >
            <div className='p-4 flex items-center justify-between gap-3'>
              <button onClick={() => setExpanded(expanded === evt.id ? null : evt.id)}
                className='text-left min-w-0 flex-1 cursor-pointer'
                style={{ background: 'transparent', border: 0, padding: 0, color: 'var(--text)' }}>
                <p className='text-sm font-semibold m-0 truncate'>{evt.name}</p>
                <p className='text-xs m-0 mt-0.5 truncate' style={{ color: 'var(--muted)' }}>
                  {evt.scope_level} · {evt.scope_church_name} · {evt.status}
                </p>
              </button>
              <button
                onClick={() => handleDownload(evt.id)}
                className='shrink-0 px-3 py-1.5 text-xs font-semibold cursor-pointer'
                style={{ background: 'var(--bg2)', color: 'var(--text)', border: '1.5px solid var(--border)', borderRadius: 'var(--radius-btn)' }}
              >
                Download CSV
              </button>
            </div>
            {expanded === evt.id && (
              <div className='px-4 pb-4 text-xs space-y-1' style={{ color: 'var(--muted)' }}>
                <p>Starts: {format(new Date(evt.starts_at), 'PP HH:mm')}</p>
                <p>Ends: {format(new Date(evt.ends_at), 'PP HH:mm')}</p>
                <p>Grace: {evt.grace_period_min} min</p>
                <p>Methods: {(evt.allowed_check_in_methods || []).join(', ')}</p>
              </div>
            )}
          </div>
        ))}
        </div>
      </main>
    </div>
  )
}

function CenterCard({ children }) {
  return (
    <div className='min-h-dvh flex items-center justify-center px-4' style={{ background: 'var(--bg)' }}>
      <div
        className='w-full max-w-md p-6 text-center'
        style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-card)', boxShadow: 'var(--shadow-2)' }}
      >
        {children}
      </div>
    </div>
  )
}
