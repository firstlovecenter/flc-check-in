import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { formatDistanceToNowStrict } from 'date-fns'
import ScreenHeader from '../ScreenHeader'
import {
  getEvent, listCheckedIn, bulkUpsertMemberProfiles,
} from '../../utils/supabaseCheckins'
import {
  getMembersInScope, memberToProfileRow,
  resolveCurrentMember, getChurchAncestors, getViewerCapabilities,
  countChildScopes, childScopeLabel,
} from '../../utils/membersApi'
import { getCurrentUser } from '../../utils/auth'

const POLL_MS = 15_000

export default function EventDashboard({ eventId }) {
  const navigate = useNavigate()
  const user = getCurrentUser()
  const [searchParams] = useSearchParams()

  // Optional child-scope filter — populated when navigating from a ScopeBreakdown card.
  const scopeLevel      = searchParams.get('scopeLevel')      || null
  const scopeChurchId   = searchParams.get('scopeChurchId')   || null
  const scopeChurchName = searchParams.get('scopeChurchName') || null

  const [event, setEvent] = useState(null)
  const [eligible, setEligible] = useState([])
  const [eligibleIds, setEligibleIds] = useState(new Set())
  const [viewerSlice, setViewerSlice] = useState([])
  const [viewerCaps, setViewerCaps] = useState(null)
  const [records, setRecords] = useState([])
  const [error, setError] = useState(null)
  const [childCount, setChildCount] = useState(null)
  const [scopedChildCount, setScopedChildCount] = useState<number | null>(null)
  const [viewerScopeChildCount, setViewerScopeChildCount] = useState<number | null>(null)

  // Initial load
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const evt = await getEvent(eventId)
        if (cancelled) return
        setEvent(evt)

        const [viewer, ancestors, eventScopeMembers, childTotal] = await Promise.all([
          resolveCurrentMember(user),
          getChurchAncestors({ level: evt.scope_level, id: evt.scope_church_id }),
          getMembersInScope({ level: evt.scope_level, churchId: evt.scope_church_id }),
          countChildScopes({ level: evt.scope_level, id: evt.scope_church_id }).catch(() => null),
        ])
        if (cancelled) return

        const allRows = eventScopeMembers.map(memberToProfileRow)
        await bulkUpsertMemberProfiles(allRows)
        const allowed = new Set(evt.allowed_roles || [])
        const eligibleRows = allRows.filter((r) => (r.roles || []).some((role) => allowed.has(role)))
        const eligibleIdSet = new Set(eligibleRows.map((r) => r.id))
        if (cancelled) return
        setEligible(eligibleRows)
        setEligibleIds(eligibleIdSet)
        setChildCount(childTotal)

        const caps = getViewerCapabilities(viewer, evt, ancestors, eligibleIdSet)
        if (cancelled) return
        setViewerCaps(caps)

        if (caps.canManage) {
          setViewerSlice(eligibleRows)
        } else if (caps.viewerScope) {
          const sliceMembers = await getMembersInScope({
            level: caps.viewerScope.level, churchId: caps.viewerScope.id,
          })
          if (cancelled) return
          const sliceIds = new Set(sliceMembers.map((m) => m.id))
          setViewerSlice(eligibleRows.filter((r) => sliceIds.has(r.id)))
        } else {
          setViewerSlice([])
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message)
      }
    })()
    return () => { cancelled = true }
  }, [eventId, user.userId, user.email]) // eslint-disable-line

  // Poll records + event
  useEffect(() => {
    if (!event) return
    let cancelled = false
    async function tick() {
      try {
        const [recs, evt] = await Promise.all([listCheckedIn(eventId), getEvent(eventId)])
        if (!cancelled) { setRecords(recs); setEvent(evt) }
      } catch (err: any) {
        if (!cancelled) setError(err.message)
      }
    }
    tick()
    const id = setInterval(tick, POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [eventId, event?.id]) // eslint-disable-line

  // Load child count for the scoped church (separate from the event-root child count).
  useEffect(() => {
    if (!scopeLevel || !scopeChurchId) return
    let cancelled = false
    countChildScopes({ level: scopeLevel, id: scopeChurchId })
      .then((n) => { if (!cancelled) setScopedChildCount(n) })
      .catch(() => { if (!cancelled) setScopedChildCount(null) })
    return () => { cancelled = true }
  }, [scopeLevel, scopeChurchId]) // eslint-disable-line

  // For non-admin leaders: load child count for their own scope (no URL scope params).
  useEffect(() => {
    if (!viewerCaps || viewerCaps.canManage || !viewerCaps.viewerScope || scopeLevel) return
    let cancelled = false
    countChildScopes({ level: viewerCaps.viewerScope.level, id: viewerCaps.viewerScope.id })
      .then((n) => { if (!cancelled) setViewerScopeChildCount(n) })
      .catch(() => { if (!cancelled) setViewerScopeChildCount(null) })
    return () => { cancelled = true }
  }, [viewerCaps?.viewerScope?.id, viewerCaps?.canManage, scopeLevel]) // eslint-disable-line

  // Members that belong to the active child-scope filter (null = no filter).
  const scopedMembers = useMemo(() => {
    if (!scopeLevel || !scopeChurchId) return null
    const idCol = `${scopeLevel}_id`
    return eligible.filter((m) => (m as any)[idCol] === scopeChurchId)
  }, [eligible, scopeLevel, scopeChurchId])

  // Stat slice: use scoped subset when a filter is active, otherwise the viewer's own slice.
  const displaySlice = useMemo(() => scopedMembers ?? viewerSlice, [scopedMembers, viewerSlice])

  const stats = useMemo(() => {
    const sliceIds = new Set(displaySlice.map((m) => m.id))
    const sliceRecords = records.filter((r) => sliceIds.has(r.member_id))
    const checkedInRecords = sliceRecords.filter((r) => r.checked_out_at == null)
    const checkedOutRecords = sliceRecords.filter((r) => r.checked_out_at != null)
    const checkedInIds = new Set(checkedInRecords.map((r) => r.member_id))
    const allRecordIds = new Set(sliceRecords.map((r) => r.member_id))
    const total = sliceIds.size
    const defaulted = displaySlice.filter((m) => !allRecordIds.has(m.id)).length
    const pct = total > 0 ? Math.round((checkedInIds.size / total) * 100) : 0
    return { total, checkedIn: checkedInIds.size, checkedOut: checkedOutRecords.length, defaulted, pct }
  }, [records, displaySlice])

  const isCheckedIn = useMemo(() => {
    if (!viewerCaps?.canCheckIn) return false
    const myRecord = records.find((r) => r.member_id === user.userId)
    return myRecord && !myRecord.checked_out_at
  }, [records, viewerCaps?.canCheckIn, user.userId])

  if (error) return <CenterCard><p style={{ color: 'var(--coral)' }}>{error}</p></CenterCard>
  if (!event || !viewerCaps) return <CenterCard><p style={{ color: 'var(--muted)' }}>Loading…</p></CenterCard>

  if (!viewerCaps.canManage && !viewerCaps.canCheckIn) {
    return (
      <CenterCard>
        <h2 className='text-lg font-semibold mb-2' style={{ color: 'var(--amber)' }}>Not in your scope</h2>
        <p className='text-sm' style={{ color: 'var(--muted)' }}>
          This event isn't part of your leadership or admin scope.
        </p>
        <Link to='/home' className='inline-block mt-4 text-sm underline' style={{ color: 'var(--accent)' }}>← Home</Link>
      </CenterCard>
    )
  }

  // Bacenta leaders bypass the dashboard
  if (!viewerCaps.canManage && viewerCaps.viewerScope?.level === 'bacenta') {
    navigate(`/checkin/${event.id}`, { replace: true })
    return null
  }

  // For non-admin leaders with no URL scope params, anchor the child-count card and
  // report links to their own scope instead of the full event scope.
  const isViewerScopedLeader = !viewerCaps.canManage && !scopeLevel && !!viewerCaps.viewerScope

  const activeScopeLevel      = scopeLevel      ?? (isViewerScopedLeader ? viewerCaps.viewerScope!.level : event.scope_level)
  const activeScopeChurchId   = scopeChurchId   ?? (isViewerScopedLeader ? viewerCaps.viewerScope!.id    : event.scope_church_id)
  const activeScopeChurchName = scopeChurchName ?? (isViewerScopedLeader ? viewerCaps.viewerScope!.name  : event.scope_church_name)

  const childLabel        = activeScopeLevel !== 'governorship' ? childScopeLabel(activeScopeLevel) : null
  const displayChildCount = scopeLevel ? scopedChildCount : isViewerScopedLeader ? viewerScopeChildCount : childCount
  const childCountLink    = `/events/${event.id}/scopes?level=${activeScopeLevel}&churchId=${activeScopeChurchId}&churchName=${encodeURIComponent(activeScopeChurchName)}`
  // Append scope filter to report URLs so FullReport pre-selects the right scope.
  const scopeFilter = activeScopeLevel !== event.scope_level || activeScopeChurchId !== event.scope_church_id
    ? `level=${activeScopeLevel}&churchId=${activeScopeChurchId}&churchName=${encodeURIComponent(activeScopeChurchName)}`
    : ''
  const endsRel = formatDistanceToNowStrict(new Date(event.ends_at), { addSuffix: true })

  return (
    <div className='min-h-dvh flex flex-col' style={{ background: 'var(--bg)' }}>
      <ScreenHeader
        title={scopeChurchName || event.name}
        onBack={scopeChurchName ? () => navigate(-1) : undefined}
        right={(
          <>
            <StatusPill status={event.status} />
            {viewerCaps.canManage && !scopeChurchName && (
              <Link
                to={`/events/${event.id}/edit`}
                aria-label='Edit event'
                className='p-2'
                style={{ background: 'var(--bg2)', border: '1.5px solid var(--border)', borderRadius: 'var(--radius-btn)', color: 'var(--text)', lineHeight: 0 }}>
                <svg viewBox='0 0 24 24' width='16' height='16' fill='currentColor'>
                  <path d='M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z' />
                </svg>
              </Link>
            )}
          </>
        )}
      />

      <main className='flex-1 w-full max-w-5xl mx-auto px-4 sm:px-6 py-5 flex flex-col gap-4'>
        {/* Event meta card */}
        <div
          className='px-4 py-4 text-center'
          style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-card)', boxShadow: 'var(--shadow-2)' }}
        >
          {scopeChurchName ? (
            <>
              <p className='eyebrow m-0 justify-center'>{event.name}</p>
              <h2 className='m-0 mt-1 text-lg font-semibold' style={{ color: 'var(--text)', letterSpacing: '-0.02em' }}>{scopeChurchName}</h2>
              <p className='text-xs mt-1.5 m-0' style={{ color: 'var(--muted)' }}>
                <span className='uppercase tracking-wider'>{scopeLevel}</span>
                {' · '}ends {endsRel}
              </p>
            </>
          ) : (
            <>
              <p className='eyebrow m-0 justify-center'>Check-In Admin</p>
              <h2 className='m-0 mt-1 text-lg font-semibold' style={{ color: 'var(--text)', letterSpacing: '-0.02em' }}>
                {event.created_by_name || '—'}
              </h2>
              <p className='text-xs mt-1.5 m-0' style={{ color: 'var(--muted)' }}>
                <span className='uppercase tracking-wider'>{event.scope_level}</span>
                {' · '}{event.scope_church_name}{' · '}ends {endsRel}
              </p>
              {!viewerCaps.canManage && (
                <p className='text-xs mt-1 m-0' style={{ color: 'var(--muted)' }}>
                  Viewing as <span style={{ color: 'var(--accent)' }}>leader</span> — {viewerCaps.viewerScope.name}
                </p>
              )}
            </>
          )}
        </div>

        {/* Check In Now hero */}
        {viewerCaps.canCheckIn && !isCheckedIn && event.status === 'ACTIVE' && (
          <button
            onClick={() => navigate(`/checkin/${event.id}`)}
            className='w-full py-4 text-base font-bold cursor-pointer btn-pill btn-primary'
          >
            Check In Now
          </button>
        )}
        {viewerCaps.canCheckIn && isCheckedIn && (
          <div
            className='w-full py-3 text-center font-semibold text-sm'
            style={{
              background: 'rgba(46,203,143,0.1)',
              color: 'var(--green)',
              border: '1.5px solid rgba(46,203,143,0.3)',
              borderRadius: 'var(--radius-btn)',
            }}
          >
            ✓ You're checked in
          </div>
        )}

        {/* Child-scope count card */}
        {childLabel && displayChildCount != null && (
          <Link
            to={childCountLink}
            className='block py-4 text-center transition-opacity hover:opacity-90 active:scale-[0.99]'
            style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-card)', textDecoration: 'none', boxShadow: 'var(--shadow-2)' }}>
            <p className='eyebrow m-0 justify-center'>{childLabel}</p>
            <p className='text-3xl font-bold m-0 mt-1' style={{ color: 'var(--text)', letterSpacing: '-0.02em' }}>{displayChildCount}</p>
          </Link>
        )}

        {/* Stat grid */}
        <div>
          <p className='eyebrow mb-3 justify-start'>Check-In Monitoring</p>
          <div className='grid grid-cols-2 md:grid-cols-4 gap-3'>
            <StatCard value={stats.checkedIn}  label='Checked In'     color='var(--green)' to={`/events/${event.id}/report?tab=checked-in${scopeFilter ? `&${scopeFilter}` : ''}`} />
            <StatCard value={stats.defaulted}  label='Defaulted'      color='var(--coral)' to={`/events/${event.id}/report?tab=defaulted${scopeFilter ? `&${scopeFilter}` : ''}`} />
            <StatCard value={stats.checkedOut} label='Checked Out'    color='var(--amber)' to={`/events/${event.id}/report?tab=checked-out${scopeFilter ? `&${scopeFilter}` : ''}`} />
            <StatCard value={stats.total}      label='Total Expected' color='var(--text)'  to={`/events/${event.id}/report${scopeFilter ? `?${scopeFilter}` : ''}`} />
          </div>
        </div>

        {/* Attendance % + full report */}
        <div className='flex items-center gap-3 mt-auto pt-1'>
          <div
            className='flex-1 py-3 text-center'
            style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-btn)' }}
          >
            <p className='text-xs m-0' style={{ color: 'var(--muted)' }}>Attendance</p>
            <p className='text-lg font-bold m-0' style={{ color: stats.pct >= 80 ? 'var(--green)' : stats.pct >= 50 ? 'var(--amber)' : 'var(--coral)' }}>{stats.pct}%</p>
          </div>
          <Link
            to={`/events/${event.id}/report${scopeFilter ? `?${scopeFilter}` : ''}`}
            className='flex-[2] block py-3 text-center text-sm font-semibold'
            style={{
              background: 'var(--accent)',
              color: '#fff',
              borderRadius: 'var(--radius-btn)',
              textDecoration: 'none',
              letterSpacing: '-0.01em',
            }}
          >
            View Full Report
          </Link>
        </div>

      </main>
    </div>
  )
}

interface StatCardProps {
  value: number
  label: string
  color: string
  to?: string
}
function StatCard({ value, label, color, to }: StatCardProps) {
  const style = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-card)', textDecoration: 'none', boxShadow: 'var(--shadow-1)' }
  const body = (
    <div className='p-4 flex flex-col items-start gap-1'>
      <span className='text-4xl font-bold' style={{ color, letterSpacing: '-0.03em', lineHeight: 1 }}>{value}</span>
      <span className='text-xs font-semibold mt-1' style={{ color: 'var(--muted)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>{label}</span>
      {to && (
        <svg viewBox='0 0 24 24' width='14' height='14' className='mt-1' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' style={{ color: 'var(--muted)', opacity: 0.6 }}>
          <path d='M9 6l6 6-6 6' />
        </svg>
      )}
    </div>
  )
  if (to) return <Link to={to} className='block transition-opacity hover:opacity-90 active:scale-[0.98]' style={style}>{body}</Link>
  return <div style={style}>{body}</div>
}

function StatusPill({ status, className = '' }) {
  const colors = {
    ACTIVE: { bg: 'rgba(46,203,143,0.12)', fg: 'var(--green)' },
    PAUSED: { bg: 'rgba(240,165,0,0.12)', fg: 'var(--amber)' },
    ENDED:  { bg: 'rgba(154,143,135,0.12)', fg: 'var(--muted)' },
  }[status] || { bg: 'var(--bg2)', fg: 'var(--text)' }
  return (
    <span
      className={`text-[10px] font-bold px-2.5 py-1 uppercase ${className}`}
      style={{ background: colors.bg, color: colors.fg, borderRadius: 'var(--radius-pill)', letterSpacing: '0.06em' }}
    >
      {status}
    </span>
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
