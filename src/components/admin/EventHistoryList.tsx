import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import ScreenHeader from '../ScreenHeader'
import { format, formatDistanceToNowStrict } from 'date-fns'
import {
  listEventsForAdminScopes, listEventsAttendedByMember, listScopedEventsForMember,
} from '../../utils/supabaseCheckins'
import { getCurrentUser } from '../../utils/auth'
import { resolveCurrentMember } from '../../utils/membersApi'

const FILTERS = ['ALL', 'ACTIVE', 'PAUSED', 'ENDED']

export default function EventHistoryList() {
  const user = getCurrentUser()
  const [events, setEvents] = useState([])
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('ALL')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // Derive the scope directly from the user's level — consistent with
        // the home screen filter. Only events scoped to the user's own church
        // appear; superadmins use the dedicated drill-down admin menu.
        const ownLevel = user.level
        const ownId    = ownLevel ? (user as any)[ownLevel]?.id : null
        const scopes   = ownLevel && ownId ? [{ level: ownLevel, id: ownId }] : []
        // resolveCurrentMember is still needed for listScopedEventsForMember
        // (personal scope-snapshot history). Swallow graph errors gracefully.
        const member = await resolveCurrentMember(user).catch(() => null)
        if (cancelled) return
        // Union three sources:
        //  1. Own scope    — events scoped to the user's own church unit
        //  2. Attended     — events the user personally checked into
        //  3. Scoped       — events the user was in scope for at creation time
        //                    (captured by stable graph ID even if they moved)
        const [adminEvts, attendedEvts, scopedEvts] = await Promise.all([
          listEventsForAdminScopes(scopes),
          listEventsAttendedByMember(user.userId),
          member?.id ? listScopedEventsForMember(member.id) : Promise.resolve([]),
        ])
        if (cancelled) return
        const byId = new Map<string, any>()
        for (const e of adminEvts)    byId.set(e.id, e)
        for (const e of attendedEvts) if (!byId.has(e.id)) byId.set(e.id, e)
        for (const e of scopedEvts)   if (!byId.has(e.id)) byId.set(e.id, e)
        const merged = [...byId.values()].sort(
          (a, b) => new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime()
        )
        if (!cancelled) setEvents(merged)
      } catch (err: any) {
        if (!cancelled) setError(err.message)
      }
    })()
    return () => { cancelled = true }
  }, [user.userId])

  const filtered = useMemo(() => {
    if (filter === 'ALL') return events
    return events.filter((e) => e.status === filter)
  }, [events, filter])

  if (error) return <CenterCard><p style={{ color: 'var(--coral)' }}>{error}</p></CenterCard>

  return (
    <div className='min-h-dvh' style={{ background: 'var(--bg)' }}>
      <ScreenHeader
        title='History'
        right={user?.isAdmin
          ? <Link to='/admin/reports' className='text-xs' style={{ color: 'var(--accent)' }}>Reports</Link>
          : null}
      />
      <main className='max-w-5xl mx-auto px-4 sm:px-6 py-6 flex flex-col gap-3'>
        <div
          className='flex gap-1 p-1'
          style={{ background: 'var(--bg2)', borderRadius: 'var(--radius-pill)', border: '1px solid var(--border)', alignSelf: 'flex-start' }}
        >
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className='px-3 py-1.5 text-xs font-semibold cursor-pointer'
              style={{
                background: filter === f ? 'var(--cta-bg)' : 'transparent',
                color: filter === f ? 'var(--cta-text)' : 'var(--muted)',
                border: 'none',
                borderRadius: 'var(--radius-pill)',
                letterSpacing: '0.02em',
              }}
            >
              {f}
            </button>
          ))}
        </div>
        {filtered.length === 0 && (
          <p className='text-sm text-center mt-6' style={{ color: 'var(--muted)' }}>No events.</p>
        )}
        <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3'>
          {filtered.map((evt) => (
            <Link
              key={evt.id}
              to={`/events/${evt.id}`}
              className='block p-4'
              style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-btn)', textDecoration: 'none' }}
            >
              <div className='flex items-start justify-between gap-3'>
                <div className='min-w-0'>
                  <p className='text-sm font-semibold m-0 truncate' style={{ color: 'var(--text)' }}>{evt.name}</p>
                  <p className='text-xs m-0 mt-0.5 truncate' style={{ color: 'var(--muted)' }}>
                    {evt.scope_level} · {evt.scope_church_name}
                  </p>
                  <p className='text-xs m-0 mt-1' style={{ color: 'var(--muted)' }}>
                    {format(new Date(evt.starts_at), 'PP HH:mm')}
                  </p>
                </div>
                <div className='text-right shrink-0'>
                  <span
                    className='text-[10px] px-2 py-0.5 font-bold uppercase'
                    style={{ ...statusStyle(evt.status), borderRadius: 'var(--radius-pill)', letterSpacing: '0.06em' }}
                  >
                    {evt.status}
                  </span>
                  <p className='text-xs m-0 mt-2' style={{ color: 'var(--muted)' }}>
                    {evt.status === 'ENDED'
                      ? `ended ${formatDistanceToNowStrict(new Date(evt.ends_at), { addSuffix: true })}`
                      : `ends ${formatDistanceToNowStrict(new Date(evt.ends_at), { addSuffix: true })}`}
                  </p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </main>
    </div>
  )
}

function statusStyle(status) {
  const c = {
    ACTIVE: { bg: 'rgba(46,203,143,0.12)', fg: 'var(--green)' },
    PAUSED: { bg: 'rgba(240,165,0,0.12)', fg: 'var(--amber)' },
    ENDED:  { bg: 'rgba(154,143,135,0.12)', fg: 'var(--muted)' },
  }[status] || { bg: 'var(--bg2)', fg: 'var(--text)' }
  return { background: c.bg, color: c.fg }
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
