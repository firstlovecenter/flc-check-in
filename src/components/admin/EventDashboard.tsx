import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { formatDistanceToNowStrict } from 'date-fns'
import NavDrawer from '../NavDrawer'
import RefreshButton from '../RefreshButton'
import PullToRefreshIndicator from '../PullToRefreshIndicator'
import { getCurrentUser } from '../../utils/auth'
import { childScopeLabel, childScopeLevel } from '../../utils/membersApi'
import { useEventEligibility } from '../../hooks/useEventEligibility'
import type { ViewerCaps } from '../../utils/eventCaps'
import { useRefreshSignal } from '../../hooks/useRefreshSignal'
import {
  getEventDashboardStats,
  getEventCheckInRate,
  getRiskyCheckInCount,
  type DashboardStats,
} from '../../utils/supabaseCheckins'
import EventLiveHeader, { AttendanceBar } from './EventLiveHeader'
import InlineScopeRollup from './InlineScopeRollup'
import EventDashboardSkeleton from './EventDashboardSkeleton'
import ChurchScopeSwitcher from '../ChurchScopeSwitcher'
import LanguageSwitcher from '../LanguageSwitcher'
import { PageShell, PageMain } from '../layout/PageShell'
import { CenterCard } from '../layout/CenterCard'
import { EmptyState } from '../layout/EmptyState'
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
const RISK_POLL_MS = 60_000

// Spread thousands of clients across the polling window instead of creating
// synchronized request spikes on round interval boundaries.
function withJitter(ms: number) {
  return Math.round(ms * (0.85 + Math.random() * 0.3))
}

/** "campus" -> "Campus". The scope line reads "Revival Campus", so the level is
 *  sentence-cased rather than the SHOUTED uppercase it used to be. */
function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''
}

function uniqueIds(ids: Array<string | null | undefined>): string[] {
  return ids.filter((id, idx, arr): id is string =>
    typeof id === 'string' && id.length > 0 && arr.indexOf(id) === idx,
  )
}

export default function EventDashboard({ eventId, capsOverride = null }: {
  eventId: string
  /** Capabilities already resolved by the entry gate from the active hat.
   *  Passing them skips useEventEligibility's legacy cascade and the two
   *  Neo4j calls that only existed to feed it. */
  capsOverride?: ViewerCaps | null
}) {
  const { t } = useTranslation()
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
  // Roster is snapshot-only (Postgres); SWR cache makes revisits instant.
  const {
    event, eligible, viewerCaps, viewerSlice,
    scopeMemberCount, error, initialLoading,
  } = useEventEligibility(eventId, user, { pollMs: POLL_MS, refreshKey, loadRecords: false, capsOverride })

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

  // Risk flags — count of members whose device fingerprint was shared.
  const [riskyCount, setRiskyCount] = useState(0)
  // Arrival rate — the "are people still coming?" signal.
  const [rate, setRate] = useState<{ recent: number; windowMin: number } | null>(null)

  // Risk analysis is secondary and changes slowly. Poll it independently so
  // the live counter cadence never doubles the RPC load.
  useEffect(() => {
    if (!eventId || !viewerCaps?.canManage) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const pollRisk = async () => {
      try {
        const count = await getRiskyCheckInCount(eventId)
        if (!cancelled) setRiskyCount(count)
      } catch { /* risk flags must not disrupt the dashboard */ }
      if (!cancelled) timer = setTimeout(pollRisk, withJitter(pageVisible ? RISK_POLL_MS : BACKGROUND_DASHBOARD_POLL_MS * 5))
    }
    pollRisk()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [eventId, viewerCaps?.canManage, pageVisible])

  // Rate only means anything while check-in is open, so don't poll otherwise.
  useEffect(() => {
    if (!eventId || event?.status !== 'ACTIVE') { setRate(null); return }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await getEventCheckInRate(eventId, 5)
        if (!cancelled) setRate(next)
      } catch { /* supplementary — never disrupt the dashboard */ }
      if (!cancelled) timer = setTimeout(poll, withJitter(pageVisible ? 30_000 : 120_000))
    }
    poll()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [eventId, event?.status, pageVisible])

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
      setDashboardStatsError(t('events.statsUnavailable'))
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
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      await fetchDashboardStats()
      if (!cancelled) timer = setTimeout(poll, withJitter(statsPollMs))
    }
    poll()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [fetchDashboardStats, statsPollMs, refreshKey])

  // Present = has a check-in record for this event.
  const isCheckedIn = !!viewerCaps?.canCheckIn && !!dashboardStats?.viewer_checked_in

  if (error) return <CenterCard><p className='text-destructive'>{error}</p></CenterCard>
  if (initialLoading || !event || !viewerCaps) {
    return (
      <PageShell>
        <EventDashboardSkeleton />
      </PageShell>
    )
  }

  if (!viewerCaps.canManage && !viewerCaps.canCheckIn && !viewerCaps.canView) {
    return (
      <PageShell>
        <PageMain>
          <EmptyState
            kind='no-scope'
            title={t('checkin.notInScopeTitle')}
            description={t('checkin.notInScopeBody')}
            action={<Link to='/home' className='text-sm font-semibold text-primary no-underline hover:underline'>{t('checkin.homeLink')}</Link>}
          />
        </PageMain>
      </PageShell>
    )
  }

  // For non-admin leaders with no URL scope params, anchor the child-count card
  // to their own scope instead of the full event scope.
  const isViewerScopedLeader = !viewerCaps.canManage && !viewerCaps.canViewFullEvent && !scopeLevel && !!viewerCaps.viewerScope

  const activeScopeLevel      = scopeLevel      ?? (isViewerScopedLeader ? viewerCaps.viewerScope!.level : event.scope_level)
  const activeScopeChurchId   = scopeChurchId   ?? (isViewerScopedLeader ? viewerCaps.viewerScope!.id    : event.scope_church_id)
  const activeScopeChurchName = scopeChurchName ?? (isViewerScopedLeader ? viewerCaps.viewerScope!.name  : event.scope_church_name)

  const childLabel        = activeScopeLevel !== 'governorship' ? childScopeLabel(activeScopeLevel) : null
  const childCountLink    = `/events/${event.id}/scopes?level=${activeScopeLevel}&churchId=${activeScopeChurchId}&churchName=${encodeURIComponent(activeScopeChurchName)}`
  const scopeFilter = activeScopeLevel !== event.scope_level || activeScopeChurchId !== event.scope_church_id
    ? `level=${activeScopeLevel}&churchId=${activeScopeChurchId}&churchName=${encodeURIComponent(activeScopeChurchName)}`
    : ''


  return (
    <PageShell>
      <NavDrawer user={user} />
      <PageMain className='flex flex-col gap-4'>
        <PullToRefreshIndicator />

        {/* Sticky chrome — padded for notch via .page-shell header.sticky */}
        <header className='sticky top-0 z-10 -mx-4 mb-1 flex items-center justify-between bg-background/95 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6'>
          {scopeChurchName ? (
            <button
              type='button'
              onClick={() => navigate(-1)}
              className='flex min-h-11 cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-xs font-medium text-primary hover:underline'
            >
              <svg viewBox='0 0 24 24' width='14' height='14' fill='currentColor'>
                <path d='M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z' />
              </svg>
              {t('events.back')}
            </button>
          ) : (
            <span />
          )}
          <div className='flex items-center gap-1.5'>
            {viewerCaps.canManage && !scopeChurchName && (
              <Link to={`/events/${event.id}/edit`} aria-label={t('events.editAria')} className='icon-btn min-h-11 min-w-11'>
                <svg viewBox='0 0 24 24' width='16' height='16' fill='currentColor'>
                  <path d='M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z' />
                </svg>
              </Link>
            )}
            <RefreshButton />
            <LanguageSwitcher />
          </div>
        </header>
        {/* Live state, loudest element on the screen. Replaces a small status
            badge plus a separate ENDED banner. */}
        <EventLiveHeader event={event} />

        {/* Title block: the meeting and the scope it belongs to, nothing else.
            The venue, the level prefix and the "ends N days ago" relative time
            all lived here and competed with the live header directly above,
            which already states the phase and the time remaining. The child
            drill-down ("Streams") that also sat here is redundant now that the
            attendance rows and the sub-scope rollup both link into the same
            member lists. */}
        <div>
          <h2 className='m-0 text-xl font-bold leading-tight tracking-tight text-foreground'>
            {event.name}
          </h2>
          <p className='m-0 mt-1 text-sm text-muted-foreground'>
            {scopeChurchName
              ? `${scopeChurchName} ${cap(scopeLevel ?? '')}`
              : `${event.scope_church_name} ${cap(event.scope_level)}`}
          </p>
        </div>

        {/* Church in Focus, on the event page too: capability here follows the
            active hat, so the control that changes it must be reachable. */}
        <ChurchScopeSwitcher />

        {viewerCaps.canCheckIn && !isCheckedIn && event.status === 'ACTIVE' && (
          <Button size='lg' className='w-full' onClick={() => navigate(`/checkin/${event.id}`, { viewTransition: true })}>
            {t('events.checkInNow')}
          </Button>
        )}
        {viewerCaps.canCheckIn && isCheckedIn && (
          <Alert variant='success' className='text-center font-semibold'>
            {t('events.checkedInBanner')}
          </Alert>
        )}


        <div>
          <div className='mb-2 flex items-center justify-between'>
            <p className='section-heading m-0 text-xs uppercase tracking-widest'>{t('events.liveCheckIns')}</p>
            <span className='text-[11px] text-muted-foreground'>
              {dashboardStats
                // Clamp the server timestamp to the past so client clock skew
                // can never render "in 5 seconds".
                ? t('events.updated', {
                    time: formatDistanceToNowStrict(
                      new Date(Math.min(Date.now(), new Date(dashboardStats.updated_at).getTime())),
                      { addSuffix: true },
                    ),
                  })
                : t('events.updating')}
            </span>
          </div>
          {dashboardStats && (
            <div className='mb-3 flex flex-col gap-2'>
              <AttendanceBar
                attended={dashboardStats.attended}
                expected={dashboardStats.attended + dashboardStats.absent}
              />
              {rate && rate.recent > 0 && (
                <p className='m-0 flex items-center gap-1.5 text-xs font-semibold text-success'>
                  <svg viewBox='0 0 24 24' width='13' height='13' fill='currentColor' aria-hidden>
                    <path d='M3.5 18.5l6-6 4 4L22 8l-1.5-1.5-7 7-4-4-7.5 7.5z' />
                  </svg>
                  {t('events.rateRecent', { count: rate.recent, minutes: rate.windowMin })}
                </p>
              )}
            </div>
          )}
          <div className='overflow-hidden rounded-2xl border border-border bg-card'>
            <LiveRow
              icon='present'
              label={t('events.present')}
              count={dashboardStats?.attended ?? '—'}
              to={`/events/${event.id}/members?status=present${scopeFilter ? `&${scopeFilter}` : ''}`}
            />
            <div className='h-px bg-border' />
            <LiveRow
              icon='absent'
              label={t('events.absent')}
              count={dashboardStats?.absent ?? '—'}
              to={`/events/${event.id}/members?status=absent${scopeFilter ? `&${scopeFilter}` : ''}`}
            />
            <div className='h-px bg-border' />
            {/* Last: Present and Absent are the outcomes, Total Expected is the
                denominator they sum to — reading it after them makes the
                arithmetic visible down the column.
                Derived as attended + absent, NOT from countEventScopeMembers:
                both metrics come from get_event_dashboard_stats over ONE
                population, so this total matches the drill-down lists by
                construction. The raw snapshot count can legitimately differ (it
                includes members excluded by allowed_roles), which would make the
                three rows fail to add up on screen. */}
            <LiveRow
              icon='expected'
              label={t('events.totalExpected')}
              count={dashboardStats ? dashboardStats.attended + dashboardStats.absent : '—'}
              to={`/events/${event.id}/members?status=all${scopeFilter ? `&${scopeFilter}` : ''}`}
            />
          </div>
          {dashboardStatsError && (
            <p className='m-0 mt-2 text-[11px] text-muted-foreground'>{dashboardStatsError}</p>
          )}
          {viewerCaps.canManage && riskyCount > 0 && (
            <Link to={`/events/${event.id}/members?status=present&flagged=1`} className='mt-3 block no-underline'>
              {/* Proxy check-in is a fraud signal, not a validation warning, so
                  it gets its own treatment and a route straight to the affected
                  members rather than the generic present list. */}
              <div className='flex items-center gap-3 rounded-2xl border-2 border-destructive/50 bg-destructive/10 px-4 py-3'>
                <span className='flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/20 text-destructive'>
                  <svg viewBox='0 0 24 24' width='18' height='18' fill='currentColor' aria-hidden>
                    <path d='M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-1 6h2v6h-2V7zm0 8h2v2h-2v-2z' />
                  </svg>
                </span>
                <div className='min-w-0 flex-1'>
                  <p className='m-0 text-sm font-bold text-destructive'>
                    {t('events.sharedDevices', { count: riskyCount })}
                  </p>
                  <p className='m-0 mt-0.5 text-xs text-destructive/80'>
                    {t('events.sharedDevicesHint')}
                  </p>
                </div>
                <svg viewBox='0 0 24 24' width='16' height='16' fill='currentColor' className='shrink-0 text-destructive' aria-hidden>
                  <path d='M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z' />
                </svg>
              </div>
            </Link>
          )}
        </div>

        {/* Per-sub-scope split, inline. For anyone overseeing several
            sub-scopes this IS the dashboard; it used to be behind a link. */}
        {canViewWholeEvent && childLabel && (
          <InlineScopeRollup
            eventId={event.id}
            childLevel={childScopeLevel(activeScopeLevel)}
            allowedRoles={event.scope_level === 'special_group' ? null : (event.allowed_roles || null)}
            fullListTo={childCountLink}
          />
        )}

        {viewerCaps.canManage && (
          <Link to={`/events/${event.id}/audit`} className='block no-underline'>
            <div className='flex items-center gap-3 overflow-hidden rounded-2xl border border-border bg-card px-4 py-3.5 transition-colors active:bg-muted/50'>
              <div className='flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted/60 text-muted-foreground'>
                <svg viewBox='0 0 24 24' width='20' height='20' fill='none' stroke='currentColor' strokeWidth='2.2' strokeLinecap='round' strokeLinejoin='round'>
                  <circle cx='12' cy='12' r='10' />
                  <polyline points='12 6 12 12 16 14' />
                </svg>
              </div>
              <span className='flex-1 text-sm font-semibold text-foreground'>{t('events.manualHistory')}</span>
              <svg viewBox='0 0 24 24' width='16' height='16' className='shrink-0 text-muted-foreground/40' fill='none' stroke='currentColor' strokeWidth='2'>
                <path d='M9 6l6 6-6 6' strokeLinecap='round' strokeLinejoin='round' />
              </svg>
            </div>
          </Link>
        )}

      </PageMain>

    </PageShell>
  )
}

// ─── Live check-in rows ──────────────────────────────────────────────────────

type LiveTone = 'expected' | 'present' | 'absent'

const LIVE_ICONS: Record<LiveTone, React.ReactNode> = {
  expected: (
    <svg viewBox='0 0 24 24' width='20' height='20' fill='none' stroke='currentColor' strokeWidth='2.2' strokeLinecap='round' strokeLinejoin='round'>
      <path d='M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' />
      <circle cx='9' cy='7' r='4' />
      <path d='M23 21v-2a4 4 0 0 0-3-3.87' />
      <path d='M16 3.13a4 4 0 0 1 0 7.75' />
    </svg>
  ),
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
  // Neutral on purpose: Total Expected is a denominator, not an outcome, so it
  // must not compete with the green/red rows it contextualises.
  expected: 'bg-secondary text-muted-foreground',
  present:  'bg-success/15 text-success',
  absent:   'bg-destructive/15 text-destructive',
}

const LIVE_VALUE_COLOR: Record<LiveTone, string> = {
  expected: 'text-foreground',
  present:  'text-success',
  absent:   'text-destructive',
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

