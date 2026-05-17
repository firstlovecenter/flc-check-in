import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import ScreenHeader from '../ScreenHeader'
import { format, formatDistanceToNowStrict } from 'date-fns'
import {
  listEventsForAdminScopes, listEventsAttendedByMember, listScopedEventsForMember,
} from '../../utils/supabaseCheckins'
import { getCurrentUser } from '../../utils/auth'
import { resolveCurrentMember } from '../../utils/membersApi'
import { getUserChurchRef } from '../../utils/userScope'
import { useRefreshSignal } from '../../hooks/useRefreshSignal'
import type { ScopeLevel } from '../../types/app'

const FILTERS = ['ALL', 'ACTIVE', 'PAUSED', 'ENDED']

export default function EventHistoryList() {
  const user = getCurrentUser()
  const [events, setEvents] = useState([])
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('ALL')
  const [search, setSearch] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  useRefreshSignal(() => setRefreshKey((k) => k + 1))

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // Derive the scope directly from the user's level — consistent with
        // the home screen filter. Only events scoped to the user's own church
        // appear; superadmins use the dedicated drill-down admin menu.
        // Resolution rules live in utils/userScope.ts.
        const ownRef = user.level ? getUserChurchRef(user, user.level as ScopeLevel) : null
        const scopes = ownRef ? [{ level: ownRef.level, id: ownRef.id }] : []
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
        const STATUS_RANK: Record<string, number> = { ACTIVE: 0, PAUSED: 1, ENDED: 2 }
        const merged = [...byId.values()].sort((a, b) => {
          const rankDiff = (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3)
          if (rankDiff !== 0) return rankDiff
          return new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime()
        })
        if (!cancelled) setEvents(merged)
      } catch (err: any) {
        if (!cancelled) setError(err.message)
      }
    })()
    return () => { cancelled = true }
  }, [user.userId, refreshKey])

  const filtered = useMemo(() => {
    const base = filter === 'ALL' ? events : events.filter((e) => e.status === filter)
    const q = search.trim().toLowerCase()
    if (!q) return base
    return base.filter((e) => {
      const haystack = [
        e.name,
        e.scope_church_name,
        e.venue_name,
        e.scope_level,
        e.status,
      ].filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(q)
    })
  }, [events, filter, search])

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
        <div
          className='px-3 py-2 flex items-center gap-2'
          style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-btn)' }}
        >
          <svg viewBox='0 0 24 24' width='16' height='16' fill='currentColor' style={{ color: 'var(--muted)', flexShrink: 0 }}>
            <path d='M15.5 14h-.79l-.28-.27a6 6 0 1 0-.71.71l.27.28v.79L20 21.5 21.5 20l-6-6zm-5.5 0a4 4 0 1 1 0-8 4 4 0 0 1 0 8z' />
          </svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder='Search events, venue, church...'
            className='w-full text-sm'
            style={{
              background: 'transparent',
              color: 'var(--text)',
              border: 'none',
              outline: 'none',
            }}
            aria-label='Search events'
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className='text-xs font-semibold px-2 py-1 cursor-pointer'
              style={{ background: 'var(--bg2)', color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: 'var(--radius-pill)' }}
            >
              Clear
            </button>
          )}
        </div>
        {filtered.length === 0 && (
          <p className='text-sm text-center mt-6' style={{ color: 'var(--muted)' }}>No events.</p>
        )}
        <div className='flex flex-col gap-2'>
          {filtered.map((evt) => {
            const sColor = { ACTIVE: 'var(--green)', PAUSED: 'var(--amber)', ENDED: 'var(--muted)' }[evt.status] || 'var(--muted)'
            const isLive = evt.status === 'ACTIVE' || evt.status === 'PAUSED'
            const timeLabel = evt.status === 'ENDED'
              ? `ended ${formatDistanceToNowStrict(new Date(evt.ends_at), { addSuffix: true })}`
              : `ends ${formatDistanceToNowStrict(new Date(evt.ends_at), { addSuffix: true })}`
            return (
              <Link
                key={evt.id}
                to={`/events/${evt.id}`}
                className='flex transition-all hover:brightness-105 active:scale-[0.99]'
                style={{
                  background: 'var(--card)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-card)',
                  textDecoration: 'none',
                  overflow: 'hidden',
                  boxShadow: isLive ? 'var(--shadow-2)' : 'var(--shadow-1)',
                }}
              >
                {/* Status accent stripe */}
                <div style={{ width: 4, background: sColor, flexShrink: 0 }} />

                <div className='px-4 py-3.5 flex-1 min-w-0 flex items-center justify-between gap-3'>
                  <div className='min-w-0 flex-1'>
                    <p
                      className='text-sm font-bold m-0 truncate'
                      style={{ color: 'var(--text)', letterSpacing: '-0.02em' }}
                    >
                      {evt.name}
                    </p>
                    <p className='text-xs m-0 mt-0.5 truncate' style={{ color: 'var(--muted)' }}>
                      <span style={{ color: sColor, fontWeight: 700, textTransform: 'uppercase', fontSize: '10px', letterSpacing: '0.04em' }}>
                        {evt.scope_level}
                      </span>
                      {' · '}{evt.scope_church_name}
                      {evt.venue_name ? ` · ${evt.venue_name}` : ''}
                    </p>
                  </div>

                  <div className='shrink-0 text-right' style={{ minWidth: 72 }}>
                    <span
                      className='text-[10px] font-bold px-2 py-0.5 uppercase'
                      style={{ ...statusStyle(evt.status), borderRadius: 'var(--radius-pill)', letterSpacing: '0.06em' }}
                    >
                      {evt.status}
                    </span>
                    <p className='text-[11px] m-0 mt-1.5' style={{ color: 'var(--muted)' }}>
                      {isLive
                        ? formatDistanceToNowStrict(new Date(evt.ends_at), { addSuffix: false })
                        : format(new Date(evt.starts_at), 'd MMM yy')}
                    </p>
                    {isLive && (
                      <p className='text-[10px] m-0' style={{ color: 'var(--muted)', opacity: 0.6 }}>remaining</p>
                    )}
                  </div>
                </div>
              </Link>
            )
          })}
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
