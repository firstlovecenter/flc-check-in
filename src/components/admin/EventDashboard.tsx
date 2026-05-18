import React, { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { formatDistanceToNowStrict } from 'date-fns'
import ScreenHeader from '../ScreenHeader'
import { getCurrentUser } from '../../utils/auth'
import { countChildScopes, childScopeLabel } from '../../utils/membersApi'
import { SCOPE_LEVELS } from '../../types/app'
import { useEventEligibility } from '../../hooks/useEventEligibility'
import { useRefreshSignal } from '../../hooks/useRefreshSignal'
import { supabase } from '../../utils/supabase'
import { listCheckedIn, getRiskyCheckIns } from '../../utils/supabaseCheckins'
import AddMemberModal from './AddMemberModal'

// Records arrive via Realtime; poll only needs to refresh event status.
const POLL_MS = 60_000

export default function EventDashboard({ eventId }) {
  const navigate = useNavigate()
  const user = getCurrentUser()
  const [searchParams] = useSearchParams()

  // Optional child-scope filter — populated when navigating from a ScopeBreakdown card.
  const scopeLevel      = searchParams.get('scopeLevel')      || null
  const scopeChurchId   = searchParams.get('scopeChurchId')   || null
  const scopeChurchName = searchParams.get('scopeChurchName') || null

  // Bumped by the global refresh signal (TopBar / ScreenHeader refresh button).
  // Passing it to useEventEligibility busts the SWR cache so the user gets
  // freshly-fetched data, not stale cached entries.
  const [refreshKey, setRefreshKey] = useState(0)
  useRefreshSignal(() => setRefreshKey((k) => k + 1))

  // Core eligibility data + poll for event status.
  // Records are refreshed instantly via Supabase Realtime (see effect below).
  // The expensive graph pipeline is SWR-cached; navigation back here is instant.
  const {
    event, eligible, eligibleIds, viewerCaps, viewerSlice,
    childCount, records, error, initialLoading, setEvent, setRecords,
  } = useEventEligibility(eventId, user, { pollMs: POLL_MS, refreshKey })

  // Supabase Realtime: push check-in record changes to the UI without waiting
  // for the poll tick. Falls back to the 60 s poll if Realtime is unavailable.
  useEffect(() => {
    if (!eventId) return
    const channel = supabase
      .channel(`dashboard:${eventId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'checkin_records', filter: `event_id=eq.${eventId}` },
        async () => {
          try {
            const recs = await listCheckedIn(eventId)
            setRecords(recs)
          } catch { /* swallow; poll covers it */ }
        },
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [eventId]) // eslint-disable-line react-hooks/exhaustive-deps

  // If the viewer is at the LOWEST level allowed for this event, there are no
  // sub-scopes for them to oversee — send them straight to check-in instead of
  // the (empty) dashboard. Applies even to admins whose admin scope happens to
  // be the lowest level in the event's allowed_roles cascade.
  useEffect(() => {
    if (!event || !user?.level) return
    const allowed: string[] = event.allowed_roles || []
    if (!allowed.length) return
    // Extract the level suffix from each role (leaderBacenta -> bacenta,
    // adminCouncil -> council), then pick the lowest by SCOPE_LEVELS index.
    let lowestIdx = Infinity
    for (const r of allowed) {
      const lvl = r.replace(/^(leader|admin)/, '').toLowerCase()
      const idx = SCOPE_LEVELS.indexOf(lvl as any)
      if (idx >= 0 && idx < lowestIdx) lowestIdx = idx
    }
    if (lowestIdx === Infinity) return
    const viewerIdx = SCOPE_LEVELS.indexOf(user.level as any)
    if (viewerIdx === lowestIdx) {
      navigate(`/checkin/${eventId}`, { replace: true })
    }
  }, [event, eventId, user?.level, navigate])

  // Child count for the URL-scoped church (when navigating from ScopeBreakdown).
  const [scopedChildCount, setScopedChildCount] = useState<number | null>(null)
  // Child count for non-admin leaders viewing their own scope (no URL params).
  const [viewerScopeChildCount, setViewerScopeChildCount] = useState<number | null>(null)
  // Risk flags — count of members whose device fingerprint was shared.
  const [riskyCount, setRiskyCount] = useState(0)
  const [showAddMember, setShowAddMember] = useState(false)
  const isSuperAdmin = !!user?.isSuperAdmin

  // Refresh risk count whenever records change (admin only).
  useEffect(() => {
    if (!eventId || !viewerCaps?.canManage || records.length === 0) return
    getRiskyCheckIns(eventId)
      .then((s) => setRiskyCount(s.size))
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, records.length, viewerCaps?.canManage])

  useEffect(() => {
    if (!scopeLevel || !scopeChurchId) return
    let cancelled = false
    countChildScopes({ level: scopeLevel, id: scopeChurchId })
      .then((n) => { if (!cancelled) setScopedChildCount(n) })
      .catch(() => { if (!cancelled) setScopedChildCount(null) })
    return () => { cancelled = true }
  }, [scopeLevel, scopeChurchId])

  useEffect(() => {
    if (!viewerCaps || viewerCaps.canManage || !viewerCaps.viewerScope || scopeLevel) return
    let cancelled = false
    countChildScopes({ level: viewerCaps.viewerScope.level, id: viewerCaps.viewerScope.id })
      .then((n) => { if (!cancelled) setViewerScopeChildCount(n) })
      .catch(() => { if (!cancelled) setViewerScopeChildCount(null) })
    return () => { cancelled = true }
  }, [viewerCaps?.viewerScope?.id, viewerCaps?.canManage, scopeLevel]) // eslint-disable-line

  // Bacenta leaders have no sub-scope to manage — skip the dashboard entirely.
  // Admin roles start from governorship upwards; bacenta viewerScope means pure leader.
  // Active event → go straight to check-in. Ended event → go home.
  useEffect(() => {
    if (!viewerCaps || !event) return
    if (viewerCaps.viewerScope?.level === 'bacenta' && !viewerCaps.canManage) {
      navigate(event.status === 'ACTIVE' ? `/checkin/${eventId}` : '/home', { replace: true })
    }
  }, [viewerCaps?.canManage, viewerCaps?.viewerScope?.level, event?.status]) // eslint-disable-line

  // Members that belong to the active child-scope filter (null = no filter).
  const scopedMembers = useMemo(() => {
    if (!scopeLevel || !scopeChurchId) return null
    const idCol = `${scopeLevel}_id`
    return eligible.filter((m) => (m as any)[idCol] === scopeChurchId)
  }, [eligible, scopeLevel, scopeChurchId])

  // Stat slice: use scoped subset when a filter is active, otherwise the viewer's own slice.
  const displaySlice = useMemo(() => scopedMembers ?? viewerSlice, [scopedMembers, viewerSlice])

  // Stats model:
  //   • attended  = anyone who has a record (cumulative — includes those who later left)
  //   • stillIn   = checked in AND not yet checked out (currently present)
  //   • left      = checked out (the "outgoing" tally for the event)
  //   • absent    = no record at all (never showed)
  // Invariants:
  //   stillIn + left   === attended
  //   attended + absent === total
  const stats = useMemo(() => {
    const sliceIds = new Set(displaySlice.map((m) => m.id))
    const sliceRecords = records.filter((r) => sliceIds.has(r.member_id))
    const leftCount = sliceRecords.filter((r) => r.checked_out_at != null).length
    const attendedIds = new Set(sliceRecords.map((r) => r.member_id))
    const stillIn = sliceRecords.length - leftCount
    const total = sliceIds.size
    const absent = displaySlice.filter((m) => !attendedIds.has(m.id)).length
    const pct = total > 0 ? Math.round((attendedIds.size / total) * 100) : 0
    return {
      total,
      attended: attendedIds.size,
      stillIn,
      left: leftCount,
      absent,
      pct,
    }
  }, [records, displaySlice])

  // A member who has checked in — even if they later checked out — is still
  // considered "checked in" for button / banner purposes.
  const isCheckedIn = useMemo(() => {
    if (!viewerCaps?.canCheckIn) return false
    return records.some((r) => r.member_id === user.userId)
  }, [records, viewerCaps?.canCheckIn, user.userId])

  if (error) return <CenterCard><p style={{ color: 'var(--coral)' }}>{error}</p></CenterCard>
  if (initialLoading || !event || !viewerCaps) return <CenterCard><p style={{ color: 'var(--muted)' }}>Loading…</p></CenterCard>

  if (!viewerCaps.canManage && !viewerCaps.canCheckIn && !viewerCaps.canView) {
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
              <h2 className='m-0 text-xl font-bold' style={{ color: 'var(--text)', letterSpacing: '-0.03em', lineHeight: 1.1 }}>
                {event.name}
              </h2>
              {event.venue_name && (
                <p className='text-sm mt-2 m-0 flex items-center justify-center gap-1' style={{ color: 'var(--muted)' }}>
                  <svg viewBox='0 0 24 24' width='13' height='13' fill='currentColor' style={{ flexShrink: 0, opacity: 0.7 }}>
                    <path d='M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z' />
                  </svg>
                  {event.venue_name}
                </p>
              )}
              <p className='text-xs mt-2 m-0' style={{ color: 'var(--muted)' }}>
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

        {/* Stat grid.
            Invariants for the four counts (assuming no manual edits):
              stillIn + left   === attended
              attended + absent === total
            "Attended" is shown as the headline percentage rather than its own
            card so admins compare Still In / Left / Absent at a glance. */}
        <div>
          <p className='eyebrow mb-3 justify-start'>Check-In Monitoring</p>
          <div className='grid grid-cols-2 md:grid-cols-4 gap-3'>
            <StatCard value={stats.stillIn}  label='Still In'       color='var(--green)' to={`/events/${event.id}/report?tab=checked-in${scopeFilter ? `&${scopeFilter}` : ''}`} />
            <StatCard value={stats.left}     label='Left'           color='var(--amber)' to={`/events/${event.id}/report?tab=checked-out${scopeFilter ? `&${scopeFilter}` : ''}`} />
            <StatCard value={stats.absent}   label='Absent'         color='var(--coral)' to={`/events/${event.id}/report?tab=defaulted${scopeFilter ? `&${scopeFilter}` : ''}`} />
            <StatCard value={stats.total}    label='Total Expected' color='var(--text)'  to={`/events/${event.id}/report${scopeFilter ? `?${scopeFilter}` : ''}`} />
          </div>
          {viewerCaps.canManage && riskyCount > 0 && (
            <Link
              to={`/events/${event.id}/report?tab=checked-in`}
              className='flex items-center gap-2 mt-3 px-3 py-2 text-sm no-underline'
              style={{
                background: 'rgba(248,112,96,0.08)',
                border: '1px solid rgba(248,112,96,0.25)',
                borderRadius: 'var(--radius-btn)',
                color: 'var(--coral)',
              }}
            >
              <span>⚠</span>
              <span>{riskyCount} member{riskyCount > 1 ? 's' : ''} flagged for shared device — possible proxy check-in</span>
            </Link>
          )}
        </div>

        {/* Attendance % + full report + audit log */}
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
          {viewerCaps.canManage && (
            <Link
              to={`/events/${event.id}/audit`}
              className='py-3 px-3 text-center text-sm font-semibold'
              style={{
                background: 'transparent',
                color: 'var(--muted)',
                border: '1.5px solid var(--border)',
                borderRadius: 'var(--radius-btn)',
                textDecoration: 'none',
                letterSpacing: '-0.01em',
                whiteSpace: 'nowrap',
              }}
            >
              Audit Log
            </Link>
          )}
        </div>

        {/* Superadmin: manually add a member to the event scope */}
        {isSuperAdmin && !scopeChurchName && (
          <button
            type='button'
            onClick={() => setShowAddMember(true)}
            className='w-full py-2.5 text-sm font-semibold cursor-pointer mt-1'
            style={{
              background: 'transparent',
              border: '1.5px dashed var(--border)',
              borderRadius: 'var(--radius-btn)',
              color: 'var(--muted)',
            }}
          >
            + Add member to event scope
          </button>
        )}

      </main>

      {showAddMember && (
        <AddMemberModal eventId={eventId} onClose={() => setShowAddMember(false)} />
      )}
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
  const style: React.CSSProperties = {
    background: 'var(--card)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-card)',
    textDecoration: 'none',
    boxShadow: 'var(--shadow-1)',
    overflow: 'hidden',
  }
  const body = (
    <div>
      {/* Colored accent stripe at top */}
      <div style={{ height: 3, background: color }} />
      <div className='px-4 pt-3 pb-4 flex flex-col items-start'>
        <span
          className='font-bold leading-none'
          style={{ color, fontSize: '2.4rem', letterSpacing: '-0.04em', lineHeight: 1 }}
        >
          {value}
        </span>
        <span
          className='mt-2'
          style={{
            color: 'var(--muted)',
            fontSize: '10px',
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          {label}
        </span>
        {to && (
          <svg
            viewBox='0 0 24 24' width='12' height='12' className='mt-1.5'
            fill='none' stroke='currentColor' strokeWidth='2.5'
            strokeLinecap='round' strokeLinejoin='round'
            style={{ color, opacity: 0.5 }}
          >
            <path d='M9 6l6 6-6 6' />
          </svg>
        )}
      </div>
    </div>
  )
  if (to) return <Link to={to} className='block transition-all hover:brightness-110 active:scale-[0.97]' style={style}>{body}</Link>
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
