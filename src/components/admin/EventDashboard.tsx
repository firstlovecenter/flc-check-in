import React, { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import Spinner from '../Spinner'
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
import { PageShell, PageMain } from '../layout/PageShell'
import { CenterCard } from '../layout/CenterCard'
import { Card, CardContent } from '../ui/card'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { Alert } from '../ui/alert'
import { cn } from '../../lib/utils'

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
    if (!event || !user?.level || user?.isSuperAdmin) return
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

  // Bacenta leaders and special-group members have no sub-scope to manage —
  // skip the dashboard entirely.
  // Active event → go straight to check-in. Ended event → go home.
  useEffect(() => {
    if (!viewerCaps || !event) return
    const isBacentaLeader = viewerCaps.viewerScope?.level === 'bacenta' && !viewerCaps.canManage
    const isSpecialGroupMember = event.scope_level === 'special_group' && !user?.isSuperAdmin
    if (isBacentaLeader || isSpecialGroupMember) {
      navigate(event.status === 'ACTIVE' ? `/checkin/${eventId}` : '/home', { replace: true })
    }
  }, [viewerCaps?.canManage, viewerCaps?.viewerScope?.level, event?.status, event?.scope_level]) // eslint-disable-line

  // Members that belong to the active child-scope filter (null = no filter).
  const scopedMembers = useMemo(() => {
    if (!scopeLevel || !scopeChurchId) return null
    const idCol = `${scopeLevel}_id`
    return eligible.filter((m) => m != null && m.id != null && (m as any)[idCol] === scopeChurchId)
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

  if (error) return <CenterCard><p className='text-destructive'>{error}</p></CenterCard>
  if (initialLoading || !event || !viewerCaps) return <Spinner fullPage />

  if (!viewerCaps.canManage && !viewerCaps.canCheckIn && !viewerCaps.canView) {
    return (
      <CenterCard>
        <h2 className='text-lg font-semibold mb-2 text-warning'>Not in your scope</h2>
        <p className='text-sm text-muted-foreground'>
          This event isn't part of your leadership or admin scope.
        </p>
        <Link to='/home' className='inline-block mt-4 text-sm underline text-primary'>← Home</Link>
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
    <PageShell>
      <ScreenHeader
        title={scopeChurchName || event.name}
        onBack={scopeChurchName ? () => navigate(-1) : undefined}
        right={(
          <>
            <StatusPill status={event.status} />
            {viewerCaps.canManage && !scopeChurchName && (
              <Link to={`/events/${event.id}/edit`} aria-label='Edit event' className='icon-btn'>
                <svg viewBox='0 0 24 24' width='16' height='16' fill='currentColor'>
                  <path d='M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z' />
                </svg>
              </Link>
            )}
          </>
        )}
      />

      <PageMain className='flex flex-col gap-4'>
        <Card>
          <CardContent className='px-4 py-4 text-center pt-4'>
          {scopeChurchName ? (
            <>
              <p className='section-heading m-0 text-center'>{event.name}</p>
              <h2 className='m-0 mt-1 text-lg font-semibold tracking-tight text-foreground'>{scopeChurchName}</h2>
              <p className='text-xs mt-1.5 m-0 text-muted-foreground'>
                <span className='uppercase tracking-wider'>{scopeLevel}</span>
                {' · '}ends {endsRel}
              </p>
            </>
          ) : (
            <>
              <h2 className='m-0 text-xl font-bold leading-tight tracking-tight text-foreground'>
                {event.name}
              </h2>
              {event.venue_name && (
                <p className='m-0 mt-2 flex items-center justify-center gap-1 text-sm text-muted-foreground'>
                  <svg viewBox='0 0 24 24' width='13' height='13' fill='currentColor' className='shrink-0 opacity-70'>
                    <path d='M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z' />
                  </svg>
                  {event.venue_name}
                </p>
              )}
              <p className='text-xs mt-2 m-0 text-muted-foreground'>
                <span className='uppercase tracking-wider'>{event.scope_level}</span>
                {' · '}{event.scope_church_name}{' · '}ends {endsRel}
              </p>
              {!viewerCaps.canManage && (
                <p className='text-xs mt-1 m-0 text-muted-foreground'>
                  Viewing as <span className='text-primary'>leader</span> — {viewerCaps.viewerScope.name}
                </p>
              )}
            </>
          )}
          </CardContent>
        </Card>

        {viewerCaps.canCheckIn && !isCheckedIn && event.status === 'ACTIVE' && (
          <Button size='lg' className='w-full' onClick={() => navigate(`/checkin/${event.id}`)}>
            Check in now
          </Button>
        )}
        {viewerCaps.canCheckIn && isCheckedIn && (
          <Alert variant='success' className='text-center font-semibold'>
            ✓ You&apos;re checked in
          </Alert>
        )}

        {childLabel && displayChildCount != null && (
          <Link to={childCountLink} className='stat-link-card block py-4 text-center no-underline active:scale-[0.99]'>
            <p className='section-heading m-0'>{childLabel}</p>
            <p className='m-0 mt-1 text-3xl font-bold tracking-tight text-foreground tnum'>{displayChildCount}</p>
          </Link>
        )}

        <div>
          <p className='section-heading mb-3'>Check-in monitoring</p>
          <div className='metric-grid'>
            <StatCard value={stats.stillIn} label='Still in' tone='present' to={`/events/${event.id}/report?tab=checked-in${scopeFilter ? `&${scopeFilter}` : ''}`} />
            <StatCard value={stats.left} label='Left' tone='late' to={`/events/${event.id}/report?tab=checked-out${scopeFilter ? `&${scopeFilter}` : ''}`} />
            <StatCard value={stats.absent} label='Absent' tone='absent' to={`/events/${event.id}/report?tab=defaulted${scopeFilter ? `&${scopeFilter}` : ''}`} />
            <StatCard value={stats.total} label='Total expected' tone='primary' to={`/events/${event.id}/report${scopeFilter ? `?${scopeFilter}` : ''}`} />
          </div>
          {viewerCaps.canManage && riskyCount > 0 && (
            <Link to={`/events/${event.id}/report?tab=checked-in`} className='mt-3 block no-underline'>
              <Alert variant='destructive' className='flex items-center gap-2'>
                <span>⚠</span>
                <span>{riskyCount} member{riskyCount > 1 ? 's' : ''} flagged for shared device — possible proxy check-in</span>
              </Alert>
            </Link>
          )}
        </div>

        <div className='mt-auto flex items-center gap-3 pt-1'>
          <Card className='flex-1'>
            <CardContent className='py-3 text-center pt-3'>
              <p className='m-0 text-xs text-muted-foreground'>Attendance</p>
              <p className={cn(
                'm-0 text-lg font-bold tnum',
                stats.pct >= 80 ? 'text-success' : stats.pct >= 50 ? 'text-warning' : 'text-destructive',
              )}>
                {stats.pct}%
              </p>
            </CardContent>
          </Card>
          <Link
            to={`/events/${event.id}/report${scopeFilter ? `?${scopeFilter}` : ''}`}
            className='btn-pill btn-primary flex-[2] py-3 text-center text-sm font-semibold no-underline'
          >
            View full report
          </Link>
          {viewerCaps.canManage && (
            <Link
              to={`/events/${event.id}/audit`}
              className='btn-pill btn-secondary whitespace-nowrap px-3 py-3 text-center text-sm font-semibold no-underline'
            >
              Audit log
            </Link>
          )}
        </div>

        {isSuperAdmin && !scopeChurchName && (
          <Button variant='outline' className='mt-1 w-full border-dashed text-muted-foreground' onClick={() => setShowAddMember(true)}>
            + Add member to event scope
          </Button>
        )}

      </PageMain>

      {showAddMember && (
        <AddMemberModal eventId={eventId} onClose={() => setShowAddMember(false)} />
      )}
    </PageShell>
  )
}

type StatTone = 'present' | 'late' | 'absent' | 'primary'

interface StatCardProps {
  value: number
  label: string
  tone: StatTone
  to?: string
}

function StatCard({ value, label, tone, to }: StatCardProps) {
  const body = (
    <div className={cn('metric-tile', `metric-tile--${tone}`)}>
      <p className='metric-tile__value tnum'>{value}</p>
      <p className='metric-tile__label'>{label}</p>
      {to && (
        <svg viewBox='0 0 24 24' width='12' height='12' className='mt-1.5 opacity-50' fill='none' stroke='currentColor' strokeWidth='2.5'>
          <path d='M9 6l6 6-6 6' strokeLinecap='round' strokeLinejoin='round' />
        </svg>
      )}
    </div>
  )
  if (to) return <Link to={to} className='block no-underline transition-all hover:brightness-[1.02] active:scale-[0.98]'>{body}</Link>
  return body
}

function StatusPill({ status, className = '' }: { status: string; className?: string }) {
  const variant =
    status === 'ACTIVE' ? 'active' : status === 'PAUSED' ? 'warning' : status === 'ENDED' ? 'muted' : 'outline'
  return <Badge variant={variant as 'active'} className={className}>{status}</Badge>
}
