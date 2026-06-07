import React, { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import Spinner from '../Spinner'
import { formatDistanceToNowStrict } from 'date-fns'
import NavDrawer from '../NavDrawer'
import RefreshButton from '../RefreshButton'
import PullToRefreshIndicator from '../PullToRefreshIndicator'
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
    event, eligible, viewerCaps, viewerSlice,
    childCount, scopeMemberCount, records, error, initialLoading, setRecords,
  } = useEventEligibility(eventId, user, { pollMs: POLL_MS, refreshKey })

  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date>(new Date())
  useEffect(() => { setLastUpdatedAt(new Date()) }, [records])

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
  //   • absent    = expected but no record (never showed)
  //   • total     = "Total Expected" — fixed at event creation, never drifts
  // Invariants:
  //   stillIn + left   === attended
  //   attended + absent === total
  const stats = useMemo(() => {
    const sliceIds = new Set(displaySlice.map((m) => m.id))
    const sliceRecords = records.filter((r) => sliceIds.has(r.member_id))
    const leftCount = sliceRecords.filter((r) => r.checked_out_at != null).length
    const attendedIds = new Set(sliceRecords.map((r) => r.member_id))
    const stillIn = sliceRecords.length - leftCount
    const attended = attendedIds.size

    // "Total Expected" is anchored to the fixed event-scope snapshot size so it
    // never changes on refresh/revisit. The slice-derived count drifts because
    // it depends on which members have a member_profiles row yet (created lazily
    // as people log in). Fall back to the slice size when viewing a child-scope
    // subset (the whole-event snapshot can't be filtered by scope) or when no
    // snapshot is available.
    const fullEventView = !scopedMembers && (viewerCaps?.canManage || !!user?.isSuperViewer)
    const total = fullEventView && scopeMemberCount != null && scopeMemberCount > 0
      ? scopeMemberCount
      : sliceIds.size

    // No one can be absent before the event is live — check-in window hasn't opened yet.
    const notStarted = !!event?.starts_at && new Date(event.starts_at) > new Date()
    const absent = notStarted ? 0 : Math.max(0, total - attended)
    const pct = total > 0 ? Math.round((attended / total) * 100) : 0
    return {
      total,
      attended,
      stillIn,
      left: leftCount,
      absent,
      pct,
    }
  }, [records, displaySlice, scopedMembers, scopeMemberCount, viewerCaps?.canManage, user?.isSuperViewer, event?.starts_at])

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

  // For non-admin leaders with no URL scope params, anchor the child-count card
  // to their own scope instead of the full event scope.
  const isViewerScopedLeader = !viewerCaps.canManage && !scopeLevel && !!viewerCaps.viewerScope

  const activeScopeLevel      = scopeLevel      ?? (isViewerScopedLeader ? viewerCaps.viewerScope!.level : event.scope_level)
  const activeScopeChurchId   = scopeChurchId   ?? (isViewerScopedLeader ? viewerCaps.viewerScope!.id    : event.scope_church_id)
  const activeScopeChurchName = scopeChurchName ?? (isViewerScopedLeader ? viewerCaps.viewerScope!.name  : event.scope_church_name)

  const childLabel        = activeScopeLevel !== 'governorship' ? childScopeLabel(activeScopeLevel) : null
  const displayChildCount = scopeLevel ? scopedChildCount : isViewerScopedLeader ? viewerScopeChildCount : childCount
  const childCountLink    = `/events/${event.id}/scopes?level=${activeScopeLevel}&churchId=${activeScopeChurchId}&churchName=${encodeURIComponent(activeScopeChurchName)}`
  const scopeFilter = activeScopeLevel !== event.scope_level || activeScopeChurchId !== event.scope_church_id
    ? `level=${activeScopeLevel}&churchId=${activeScopeChurchId}&churchName=${encodeURIComponent(activeScopeChurchName)}`
    : ''
  const endsRel = formatDistanceToNowStrict(new Date(event.ends_at), { addSuffix: true })

  const adminName = event.created_by_name || 'Admin'
  const adminInitials = adminName.split(' ').map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?'
  const isOwnEvent = event.created_by_id === user?.userId
  const pictureUrl = isOwnEvent && typeof window !== 'undefined' ? localStorage.getItem('pictureUrl') : null
  const roleLabel = 'Check-in Admin'

  return (
    <PageShell>
      <PageMain className='flex flex-col gap-4'>
        <PullToRefreshIndicator />

        {/* Inline nav row — not sticky, scrolls with content */}
        <div className='flex items-center justify-between'>
          {scopeChurchName ? (
            <button
              type='button'
              onClick={() => navigate(-1)}
              className='flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-xs font-medium text-primary hover:underline'
            >
              <svg viewBox='0 0 24 24' width='14' height='14' fill='currentColor'>
                <path d='M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z' />
              </svg>
              Back
            </button>
          ) : (
            <span />
          )}
          <div className='flex items-center gap-1.5'>
            {event.status !== 'ENDED' && <StatusPill status={event.status} />}
            {viewerCaps.canManage && !scopeChurchName && (
              <Link to={`/events/${event.id}/edit`} aria-label='Edit event' className='icon-btn'>
                <svg viewBox='0 0 24 24' width='16' height='16' fill='currentColor'>
                  <path d='M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z' />
                </svg>
              </Link>
            )}
            <RefreshButton />
            <NavDrawer user={user} />
          </div>
        </div>
        {event.status === 'ENDED' && (
          <div className='flex items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3.5 text-sm font-semibold text-destructive'>
            <svg viewBox='0 0 24 24' width='18' height='18' fill='currentColor' className='shrink-0'>
              <path d='M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z' />
            </svg>
            <span>This event has ended. Check-in is closed.</span>
          </div>
        )}
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
              <IdentityRow adminName={adminName} adminInitials={adminInitials} pictureUrl={pictureUrl} roleLabel={roleLabel} childLabel={childLabel} displayChildCount={displayChildCount} childCountLink={childCountLink} />
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
              <IdentityRow adminName={adminName} adminInitials={adminInitials} pictureUrl={pictureUrl} roleLabel={roleLabel} childLabel={childLabel} displayChildCount={displayChildCount} childCountLink={childCountLink} />
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


        <div>
          <div className='mb-2 flex items-center justify-between'>
            <p className='section-heading m-0 text-xs uppercase tracking-widest'>Live Check-Ins</p>
            <span className='text-[11px] text-muted-foreground'>
              Updated {formatDistanceToNowStrict(lastUpdatedAt, { addSuffix: true })}
            </span>
          </div>
          <div className='mb-3 flex items-center gap-1.5'>
            <span className='relative flex h-2 w-2'>
              <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60' />
              <span className='relative inline-flex h-2 w-2 rounded-full bg-success' />
            </span>
            <span className='text-[11px] font-semibold uppercase tracking-wider text-success'>Realtime</span>
          </div>
          <div className='flex flex-col gap-3'>
            <div className='overflow-hidden rounded-2xl border border-border bg-card'>
              <LiveRow
                icon='pct'
                label='Attendance'
                count={`${stats.pct}%`}
                valueClass={stats.pct >= 80 ? 'text-success' : stats.pct >= 50 ? 'text-warning' : 'text-destructive'}
              />
            </div>
            <div className='overflow-hidden rounded-2xl border border-border bg-card'>
              <LiveRow
                icon='present'
                label='Leaders Checked In'
                count={stats.attended}
                to={`/events/${event.id}/members?status=present${scopeFilter ? `&${scopeFilter}` : ''}`}
              />
              <div className='h-px bg-border' />
              <LiveRow
                icon='absent'
                label='Leaders Absent'
                count={stats.absent}
                to={`/events/${event.id}/members?status=absent${scopeFilter ? `&${scopeFilter}` : ''}`}
              />
              <div className='h-px bg-border' />
              <LiveRow
                icon='primary'
                label='Total Expected'
                count={stats.total}
                to={`/events/${event.id}/members?status=all${scopeFilter ? `&${scopeFilter}` : ''}`}
              />
            </div>
          </div>
          {viewerCaps.canManage && riskyCount > 0 && (
            <Link to={`/events/${event.id}/members?status=present`} className='mt-3 block no-underline'>
              <Alert variant='destructive' className='flex items-center gap-2'>
                <span>⚠</span>
                <span>{riskyCount} member{riskyCount > 1 ? 's' : ''} flagged for shared device — possible proxy check-in</span>
              </Alert>
            </Link>
          )}
        </div>

        {viewerCaps.canManage && (
          <Link to={`/events/${event.id}/audit`} className='block no-underline'>
            <div className='flex items-center gap-3 overflow-hidden rounded-2xl border border-border bg-card px-4 py-3.5 transition-colors active:bg-muted/50'>
              <div className='flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted/60 text-muted-foreground'>
                <svg viewBox='0 0 24 24' width='20' height='20' fill='none' stroke='currentColor' strokeWidth='2.2' strokeLinecap='round' strokeLinejoin='round'>
                  <circle cx='12' cy='12' r='10' />
                  <polyline points='12 6 12 12 16 14' />
                </svg>
              </div>
              <span className='flex-1 text-sm font-semibold text-foreground'>Manual check-in history</span>
              <svg viewBox='0 0 24 24' width='16' height='16' className='shrink-0 text-muted-foreground/40' fill='none' stroke='currentColor' strokeWidth='2'>
                <path d='M9 6l6 6-6 6' strokeLinecap='round' strokeLinejoin='round' />
              </svg>
            </div>
          </Link>
        )}

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

type LiveTone = 'present' | 'absent' | 'primary' | 'pct'

const LIVE_ICONS: Record<LiveTone, React.ReactNode> = {
  present: (
    <svg viewBox='0 0 24 24' width='20' height='20' fill='none' stroke='currentColor' strokeWidth='2.2' strokeLinecap='round' strokeLinejoin='round'>
      <path d='M20 6L9 17l-5-5' />
    </svg>
  ),
  absent: (
    <svg viewBox='0 0 24 24' width='20' height='20' fill='none' stroke='currentColor' strokeWidth='2.2' strokeLinecap='round' strokeLinejoin='round'>
      <path d='M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z' />
      <line x1='12' y1='9' x2='12' y2='13' />
      <line x1='12' y1='17' x2='12.01' y2='17' />
    </svg>
  ),
  primary: (
    <svg viewBox='0 0 24 24' width='20' height='20' fill='none' stroke='currentColor' strokeWidth='2.2' strokeLinecap='round' strokeLinejoin='round'>
      <path d='M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' />
      <circle cx='9' cy='7' r='4' />
      <path d='M23 21v-2a4 4 0 0 0-3-3.87' />
      <path d='M16 3.13a4 4 0 0 1 0 7.75' />
    </svg>
  ),
  pct: (
    <svg viewBox='0 0 24 24' width='20' height='20' fill='none' stroke='currentColor' strokeWidth='2.2' strokeLinecap='round' strokeLinejoin='round'>
      <line x1='19' y1='5' x2='5' y2='19' />
      <circle cx='6.5' cy='6.5' r='2.5' />
      <circle cx='17.5' cy='17.5' r='2.5' />
    </svg>
  ),
}

const LIVE_ICON_BG: Record<LiveTone, string> = {
  present: 'bg-success/15 text-success',
  absent:  'bg-destructive/15 text-destructive',
  primary: 'bg-primary/15 text-primary',
  pct:     'bg-muted/60 text-muted-foreground',
}

const LIVE_VALUE_COLOR: Record<LiveTone, string> = {
  present: 'text-success',
  absent:  'text-destructive',
  primary: 'text-foreground',
  pct:     'text-foreground',
}

function LiveRow({ icon, label, count, to, valueClass }: {
  icon: LiveTone
  label: string
  count: number | string
  to?: string
  valueClass?: string
}) {
  const body = (
    <div className='flex items-center gap-3 px-4 py-3.5 transition-colors active:bg-muted/50'>
      <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-full', LIVE_ICON_BG[icon])}>
        {LIVE_ICONS[icon]}
      </div>
      <span className='flex-1 text-sm font-semibold text-foreground'>{label}</span>
      <span className={cn('tnum text-xl font-bold', valueClass ?? LIVE_VALUE_COLOR[icon])}>{count}</span>
      {to && (
        <svg viewBox='0 0 24 24' width='16' height='16' className='shrink-0 text-muted-foreground/40' fill='none' stroke='currentColor' strokeWidth='2'>
          <path d='M9 6l6 6-6 6' strokeLinecap='round' strokeLinejoin='round' />
        </svg>
      )}
    </div>
  )
  if (to) return <Link to={to} className='block no-underline'>{body}</Link>
  return body
}

function IdentityRow({ adminName, adminInitials, pictureUrl, roleLabel, childLabel, displayChildCount, childCountLink }: {
  adminName: string; adminInitials: string; pictureUrl: string | null
  roleLabel: string; childLabel: string | null; displayChildCount: number | null; childCountLink: string
}) {
  return (
    <div className='mt-4 flex items-center gap-2'>
      <div className='flex items-center gap-2 rounded-full border border-border bg-background px-1.5 py-1.5 pr-4'>
        {pictureUrl ? (
          <img src={pictureUrl} alt={adminName} className='h-10 w-10 shrink-0 rounded-full object-cover ring-2 ring-border' />
        ) : (
          <div className='flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground ring-2 ring-primary/30'>
            {adminInitials}
          </div>
        )}
        <div className='flex flex-col'>
          <span className='text-sm font-semibold text-foreground'>{adminName}</span>
          <span className='text-[10px] font-medium text-primary'>{roleLabel}</span>
        </div>
      </div>

      {childLabel && displayChildCount != null && (
        <Link
          to={childCountLink}
          className='flex items-center gap-2 rounded-full border border-border bg-background px-1.5 py-1.5 pr-4 no-underline hover:bg-accent'
        >
          <div className='flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-bold text-foreground'>
            {displayChildCount}
          </div>
          <div className='flex flex-col'>
            <span className='text-sm font-semibold text-foreground'>{childLabel}</span>
            <span className='flex items-center gap-0.5 text-[10px] font-medium text-muted-foreground'>
              View
              <svg viewBox='0 0 24 24' width='10' height='10' fill='none' stroke='currentColor' strokeWidth='2.5' strokeLinecap='round' strokeLinejoin='round'>
                <path d='M9 18l6-6-6-6'/>
              </svg>
            </span>
          </div>
        </Link>
      )}
    </div>
  )
}

function StatusPill({ status, className = '' }: { status: string; className?: string }) {
  const variant =
    status === 'ACTIVE' ? 'active' : status === 'PAUSED' ? 'warning' : status === 'ENDED' ? 'muted' : 'outline'
  return <Badge variant={variant as 'active'} className={className}>{status}</Badge>
}
