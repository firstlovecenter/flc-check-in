import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Skeleton } from '../ui/skeleton'
import { formatDistanceToNowStrict } from 'date-fns'
import NavDrawer from '../NavDrawer'
import RefreshButton from '../RefreshButton'
import PullToRefreshIndicator from '../PullToRefreshIndicator'
import { getCurrentUser } from '../../utils/auth'
import { countChildScopes, childScopeLabel } from '../../utils/membersApi'
import { useEventEligibility } from '../../hooks/useEventEligibility'
import { useRefreshSignal } from '../../hooks/useRefreshSignal'
import {
  getEventDashboardStats,
  getRiskyCheckInCount,
  type DashboardStats,
} from '../../utils/supabaseCheckins'
import AddMemberModal from './AddMemberModal'
import { PageShell, PageMain } from '../layout/PageShell'
import { CenterCard } from '../layout/CenterCard'
import { Card, CardContent } from '../ui/card'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { Alert } from '../ui/alert'
import { cn } from '../../lib/utils'

// Event status is checked separately from dashboard summary stats.
const POLL_MS = 60_000
const CREATOR_DASHBOARD_POLL_MS = 8_000
const ADMIN_DASHBOARD_POLL_MS = 15_000
const MONITOR_DASHBOARD_POLL_MS = 30_000
const BACKGROUND_DASHBOARD_POLL_MS = 60_000

function uniqueIds(ids: Array<string | null | undefined>): string[] {
  return ids.filter((id, idx, arr): id is string =>
    typeof id === 'string' && id.length > 0 && arr.indexOf(id) === idx,
  )
}

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

  // Core eligibility data + cheap poll for event status.
  // Dashboard counters use aggregate RPC polling below, not full record loads.
  // The expensive graph pipeline is SWR-cached; navigation back here is instant.
  const {
    event, eligible, viewerCaps, viewerSlice,
    childCount, scopeMemberCount, error, initialLoading,
  } = useEventEligibility(eventId, user, { pollMs: POLL_MS, refreshKey, loadRecords: false })

  const [dashboardStats, setDashboardStats] = useState<DashboardStats | null>(null)
  const [dashboardStatsError, setDashboardStatsError] = useState<string | null>(null)

  // Slow the stats poll right down while the tab is hidden.
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible',
  )
  useEffect(() => {
    const onVisibility = () => setPageVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  // Dashboard stats and child-scope queries run only after the entry gate
  // has decided this viewer should see the dashboard (not self check-in).
  // Child count for the URL-scoped church (when navigating from ScopeBreakdown).
  const [scopedChildCount, setScopedChildCount] = useState<number | null>(null)
  // Child count for non-admin leaders viewing their own scope (no URL params).
  const [viewerScopeChildCount, setViewerScopeChildCount] = useState<number | null>(null)
  // Risk flags — count of members whose device fingerprint was shared.
  const [riskyCount, setRiskyCount] = useState(0)
  const [showAddMember, setShowAddMember] = useState(false)
  const isSuperAdmin = !!user?.isSuperAdmin

  // Refresh risk count alongside dashboard stats (admin only).
  useEffect(() => {
    if (!eventId || !viewerCaps?.canManage) return
    getRiskyCheckInCount(eventId)
      .then(setRiskyCount)
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, dashboardStats?.updated_at, viewerCaps?.canManage])

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

  // Bacenta leaders and special-group members: entry gate routes to check-in or
  // home before this screen mounts for self-service attendees.
  // Members that belong to the active child-scope filter (null = no filter).
  const scopedMembers = useMemo(() => {
    if (!scopeLevel || !scopeChurchId) return null
    const idCol = `${scopeLevel}_id`
    return eligible.filter((m) => {
      if (m == null || m.id == null) return false
      const scopeIds: string[] | undefined = (m.scope_ids as any)?.[scopeLevel]
      if (scopeIds?.length) return scopeIds.includes(scopeChurchId)
      return (m as any)[idCol] === scopeChurchId
    })
  }, [eligible, scopeLevel, scopeChurchId])

  // Stat slice: use scoped subset when a filter is active, otherwise the viewer's own slice.
  const canViewWholeEvent = !!(viewerCaps?.canManage || viewerCaps?.canViewFullEvent)
  const displaySlice = useMemo(
    () => scopedMembers ?? (canViewWholeEvent ? eligible : viewerSlice),
    [scopedMembers, canViewWholeEvent, eligible, viewerSlice],
  )

  // Only two attendance metrics exist: Present and Absent, and both are
  // counted over ONE population so the headline always matches the drill-down
  // lists. Postgres does the counting (get_event_dashboard_stats):
  //   • memberIds     — explicit population (viewer slice / drill-down).
  //   • allowedRoles  — whole-event view: the RPC derives the population from
  //                     the event-scope snapshot filtered by these roles
  //                     against member_profiles.roles — the same rule the
  //                     client uses to build `eligible`, so the numbers agree
  //                     with ScopeBreakdown / member lists by construction.
  //   • notStarted    — no one can be absent before check-in opens. Evaluated
  //                     per fetch (below), not here: this memo's deps are all
  //                     stable after load, so a value captured here would
  //                     freeze at mount and pin Absent at 0 for viewers who
  //                     opened the dashboard before the event started.
  // Deps are primitive event fields, not the event object — the 60s status
  // poll replaces the object identity every tick and would otherwise reset
  // the stats interval each time.
  const allowedRolesKey = (event?.allowed_roles || []).join('|')
  const statsInputs = useMemo(() => {
    if (!event || !viewerCaps) return null
    // Same predicate that picked displaySlice — the RPC must count exactly
    // the population the UI links to.
    const fullEventView = !scopedMembers && canViewWholeEvent
    const startsAt = event.starts_at ?? null
    // scopeMemberCount > 0 ⇒ a scope snapshot exists, so the RPC can derive
    // the population server-side. Special-group membership IS eligibility —
    // no role filter. Legacy snapshot-less events fall through to memberIds.
    if (fullEventView && scopeMemberCount != null && scopeMemberCount > 0) {
      return {
        memberIds: null as string[] | null,
        allowedRoles: event.scope_level === 'special_group' ? null : (event.allowed_roles || []),
        startsAt,
      }
    }
    return { memberIds: uniqueIds(displaySlice.map((m) => m.id)), allowedRoles: null, startsAt }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event?.id, event?.scope_level, event?.starts_at, allowedRolesKey, viewerCaps, canViewWholeEvent, scopedMembers, scopeMemberCount, displaySlice])

  const fetchDashboardStats = useCallback(async () => {
    if (!eventId || !statsInputs) return
    const notStarted = !!statsInputs.startsAt && new Date(statsInputs.startsAt) > new Date()
    // Empty slice — nobody to count. Don't call the RPC: an empty memberIds
    // array means "no filter" in Postgres and would count the whole event.
    if (statsInputs.memberIds && statsInputs.memberIds.length === 0) {
      setDashboardStats({ attended: 0, absent: 0, viewer_checked_in: false, updated_at: new Date().toISOString() })
      setDashboardStatsError(null)
      return
    }
    try {
      const stats = await getEventDashboardStats({
        eventId,
        memberIds: statsInputs.memberIds,
        allowedRoles: statsInputs.allowedRoles,
        notStarted,
        viewerMemberIds: uniqueIds([user?.userId, user?.graphMemberId]),
      })
      setDashboardStats(stats)
      setDashboardStatsError(null)
    } catch {
      // Keep showing the last good numbers; surface a quiet notice.
      setDashboardStatsError('Live stats are temporarily unavailable.')
    }
  }, [eventId, statsInputs, user?.userId, user?.graphMemberId])

  // Aggregate poll — the event creator watches closest, admins next, everyone
  // else at monitor cadence; hidden tabs drop to the background rate.
  const isCreator = !!user?.userId && event?.created_by_id === user.userId
  const statsPollMs = !pageVisible
    ? BACKGROUND_DASHBOARD_POLL_MS
    : isCreator
    ? CREATOR_DASHBOARD_POLL_MS
    : viewerCaps?.canManage
    ? ADMIN_DASHBOARD_POLL_MS
    : MONITOR_DASHBOARD_POLL_MS

  useEffect(() => {
    fetchDashboardStats()
    const id = setInterval(fetchDashboardStats, statsPollMs)
    return () => clearInterval(id)
  }, [fetchDashboardStats, statsPollMs, refreshKey])

  // Present = has a check-in record for this event.
  const isCheckedIn = !!viewerCaps?.canCheckIn && !!dashboardStats?.viewer_checked_in

  if (error) return <CenterCard><p className='text-destructive'>{error}</p></CenterCard>
  // Progressive shell instead of a blocking full-page spinner: the layout
  // (nav row, event card, stat rows) appears immediately, so the eventual
  // data paint causes no layout shift.
  if (initialLoading || !event || !viewerCaps) return <DashboardSkeleton />

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
  const isViewerScopedLeader = !viewerCaps.canManage && !viewerCaps.canViewFullEvent && !scopeLevel && !!viewerCaps.viewerScope

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
              <IdentityRow childLabel={childLabel} displayChildCount={displayChildCount} childCountLink={childCountLink} />
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
              <IdentityRow childLabel={childLabel} displayChildCount={displayChildCount} childCountLink={childCountLink} />
            </>
          )}
          </CardContent>
        </Card>

        {viewerCaps.canCheckIn && !isCheckedIn && event.status === 'ACTIVE' && (
          <Button size='lg' className='w-full' onClick={() => navigate(`/checkin/${event.id}`, { viewTransition: true })}>
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
              {dashboardStats
                // Clamp the server timestamp to the past so client clock skew
                // can never render "in 5 seconds".
                ? `Updated ${formatDistanceToNowStrict(
                    new Date(Math.min(Date.now(), new Date(dashboardStats.updated_at).getTime())),
                    { addSuffix: true },
                  )}`
                : 'Updating…'}
            </span>
          </div>
          <div className='mb-3 flex items-center gap-1.5'>
            <span className='relative flex h-2 w-2'>
              <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60' />
              <span className='relative inline-flex h-2 w-2 rounded-full bg-success' />
            </span>
            <span className='text-[11px] font-semibold uppercase tracking-wider text-success'>Live</span>
          </div>
          <div className='overflow-hidden rounded-2xl border border-border bg-card'>
            <LiveRow
              icon='present'
              label='Present'
              count={dashboardStats?.attended ?? '—'}
              to={`/events/${event.id}/members?status=present${scopeFilter ? `&${scopeFilter}` : ''}`}
            />
            <div className='h-px bg-border' />
            <LiveRow
              icon='absent'
              label='Absent'
              count={dashboardStats?.absent ?? '—'}
              to={`/events/${event.id}/members?status=absent${scopeFilter ? `&${scopeFilter}` : ''}`}
            />
          </div>
          {dashboardStatsError && (
            <p className='m-0 mt-2 text-[11px] text-muted-foreground'>{dashboardStatsError}</p>
          )}
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

// Mirrors the loaded dashboard's layout so the data paint causes no shift.
function DashboardSkeleton() {
  return (
    <PageShell>
      <PageMain className='flex flex-col gap-4'>
        <div className='flex items-center justify-between'>
          <Skeleton className='h-5 w-16' />
          <Skeleton className='h-9 w-24 rounded-full' />
        </div>
        <div className='rounded-2xl border border-border bg-card px-4 py-6 text-center'>
          <Skeleton className='mx-auto h-6 w-2/3' />
          <Skeleton className='mx-auto mt-3 h-4 w-1/2' />
          <Skeleton className='mx-auto mt-2 h-3 w-1/3' />
        </div>
        <div>
          <Skeleton className='mb-3 h-3 w-28' />
          <Skeleton className='h-[121px] rounded-2xl' />
        </div>
      </PageMain>
    </PageShell>
  )
}

type LiveTone = 'present' | 'absent'

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
}

const LIVE_ICON_BG: Record<LiveTone, string> = {
  present: 'bg-success/15 text-success',
  absent:  'bg-destructive/15 text-destructive',
}

const LIVE_VALUE_COLOR: Record<LiveTone, string> = {
  present: 'text-success',
  absent:  'text-destructive',
}

function LiveRow({ icon, label, count, to }: {
  icon: LiveTone
  label: string
  count: number | string
  to?: string
}) {
  const body = (
    <div className='flex items-center gap-3 px-4 py-3.5 transition-colors active:bg-muted/50'>
      <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-full', LIVE_ICON_BG[icon])}>
        {LIVE_ICONS[icon]}
      </div>
      <span className='flex-1 text-sm font-semibold text-foreground'>{label}</span>
      <span className={cn('tnum text-xl font-bold', LIVE_VALUE_COLOR[icon])}>{count}</span>
      {to && (
        <svg viewBox='0 0 24 24' width='16' height='16' className='shrink-0 text-muted-foreground/40' fill='none' stroke='currentColor' strokeWidth='2'>
          <path d='M9 6l6 6-6 6' strokeLinecap='round' strokeLinejoin='round' />
        </svg>
      )}
    </div>
  )
  if (to) return <Link to={to} viewTransition className='block no-underline'>{body}</Link>
  return body
}

function IdentityRow({ childLabel, displayChildCount, childCountLink }: {
  childLabel: string | null; displayChildCount: number | null; childCountLink: string
}) {
  // Keep the drill chip visible while the child-count RPC is in flight.
  // Hiding until count arrives made drills look "gone" after entry-gate work
  // (slow/failed count ⇒ blank IdentityRow).
  if (!childLabel) return null
  const countLabel = displayChildCount == null ? '…' : String(displayChildCount)
  return (
    <div className='mt-4 flex items-center gap-2'>
      <Link
        to={childCountLink}
        className='flex items-center gap-2 rounded-full border border-border bg-background px-1.5 py-1.5 pr-4 no-underline hover:bg-accent'
      >
        <div className='flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-bold text-foreground'>
          {countLabel}
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
    </div>
  )
}

function StatusPill({ status, className = '' }: { status: string; className?: string }) {
  const variant =
    status === 'ACTIVE' ? 'active' : status === 'PAUSED' ? 'warning' : status === 'ENDED' ? 'muted' : 'outline'
  return <Badge variant={variant as 'active'} className={className}>{status}</Badge>
}
