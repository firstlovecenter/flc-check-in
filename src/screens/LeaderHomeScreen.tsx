import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import Spinner from '../components/Spinner'
import NavDrawer from '../components/NavDrawer'
import PullToRefreshIndicator from '../components/PullToRefreshIndicator'
import { PageShell, PageMain } from '../components/layout/PageShell'
import { EmptyState } from '../components/layout/EmptyState'
import { Alert } from '../components/ui/alert'
import { Button } from '../components/ui/button'
import ChurchScopeSwitcher from '../components/ChurchScopeSwitcher'
import { canCreateMeetings, getCurrentUser, persistChurchContextFromProfileRow, persistChurchContextFromJwt } from '../utils/auth'
import {
  listAllEvents, getMemberProfile, upsertMemberProfile,
  getEvent, listCheckedIn,
} from '../utils/supabaseCheckins'
import { useRefreshSignal } from '../hooks/useRefreshSignal'
import { getUserChurchRefs } from '../utils/userScope'
import { useChurchFocus } from '../contexts/ChurchFocusContext'
import type { AppUser, CheckinEventRow } from '../types/app'

type Greeting = { line1: string; line2: string }

const MORNING_GREETINGS: Greeting[] = [
  { line1: 'Good morning, {name}.', line2: 'The registers are open.' },
  { line1: 'Rise and lead, {name}.', line2: 'Leaders are gathering.' },
  { line1: 'Daybreak, {name}.', line2: 'Steady hands. Holy work.' },
  { line1: 'Early start, {name}.', line2: 'The faithful show up first.' },
  { line1: 'Morning, {name}.', line2: 'Another day of faithful service.' },
  { line1: 'Up and counting, {name}.', line2: 'Leaders are assembling.' },
]

const MIDDAY_GREETINGS: Greeting[] = [
  { line1: 'Good afternoon, {name}.', line2: 'Keep the count going.' },
  { line1: 'Midday, {name}.', line2: 'The session is live.' },
  { line1: 'Still going, {name}.', line2: 'Leaders are still showing up.' },
  { line1: 'Pressing on, {name}.', line2: 'Every leader counted matters.' },
  { line1: 'Halfway there, {name}.', line2: 'Faithful in the afternoon too.' },
  { line1: 'Afternoon, {name}.', line2: 'The registers are open.' },
]

const EVENING_GREETINGS: Greeting[] = [
  { line1: 'Good evening, {name}.', line2: 'Leaders are gathering.' },
  { line1: 'Evening service, {name}.', line2: 'Mark them present.' },
  { line1: 'The evening watch, {name}.', line2: 'Faithful to the end.' },
  { line1: 'Twilight roll call, {name}.', line2: 'Every leader accounted for.' },
  { line1: 'Evening, {name}.', line2: 'The day\'s work continues.' },
  { line1: 'Last count, {name}.', line2: 'Make it a good one.' },
]

const NIGHT_GREETINGS: Greeting[] = [
  { line1: 'Quiet hours, {name}.', line2: 'Steady hands. Holy work.' },
  { line1: 'Late session, {name}.', line2: 'The dedicated ones are here.' },
  { line1: 'Night watch, {name}.', line2: 'Still counting. Still faithful.' },
  { line1: 'Burning bright, {name}.', line2: 'Late night faithfulness.' },
  { line1: 'Stars are out, {name}.', line2: 'So are your leaders.' },
  { line1: 'The last hour, {name}.', line2: 'Mark them present.' },
]

const ADMIN_GREETINGS: Greeting[] = [
  { line1: 'Good to see you, {name}.', line2: 'The registers are yours.' },
  { line1: 'Steady oversight, {name}.', line2: 'Every leader has a name.' },
  { line1: 'Track well, {name}.', line2: 'Lead well.' },
  { line1: 'The numbers matter, {name}.', line2: 'Keep them true.' },
  { line1: 'Your leaders need you, {name}.', line2: 'Every check-in counts.' },
  { line1: 'Faithful records, {name}.', line2: 'Good decisions tomorrow.' },
  { line1: 'Precision, {name}.', line2: 'In attendance. In ministry.' },
  { line1: 'Behind every check-in, {name}.', line2: 'A leader you\'re investing in.' },
  { line1: 'Strong team, {name}.', line2: 'You track who shows up.' },
  { line1: 'Accountability, {name}.', line2: 'Starts with who shows up.' },
  { line1: 'The register, {name}.', line2: 'Is your first report card.' },
  { line1: 'Excellence, {name}.', line2: 'In check-in and leadership.' },
  { line1: 'Your oversight, {name}.', line2: 'Makes all the difference.' },
  { line1: 'A well-run event, {name}.', line2: 'Starts with you.' },
  { line1: 'Every absent leader, {name}.', line2: 'Has a name. Know it.' },
  { line1: 'Good records, {name}.', line2: 'Better decisions tomorrow.' },
  { line1: 'Faithfulness, {name}.', line2: 'Is measurable. You\'re measuring it.' },
  { line1: 'The health of the team, {name}.', line2: 'Shows in attendance.' },
  { line1: 'Holding the line, {name}.', line2: 'One check-in at a time.' },
  { line1: 'All eyes on the register, {name}.', line2: 'Make it count.' },
]

const LEADER_GREETINGS: Greeting[] = [
  { line1: 'Present and counted, {name}.', line2: 'Your faithfulness is noted.' },
  { line1: 'You showed up, {name}.', line2: 'That\'s already leadership.' },
  { line1: 'On time, {name}.', line2: 'Is a form of leadership.' },
  { line1: 'Here you are, {name}.', line2: 'Counted. Present. Valued.' },
  { line1: 'Good to see you, {name}.', line2: 'Your presence speaks first.' },
  { line1: 'Consistent, {name}.', line2: 'Its own kind of excellence.' },
  { line1: 'Show up, {name}.', line2: 'Lead up.' },
  { line1: 'Faithful, {name}.', line2: 'In the small things — like showing up.' },
  { line1: 'In the room, {name}.', line2: 'Where it matters most.' },
  { line1: 'Here, {name}.', line2: 'Present and ready to serve.' },
  { line1: 'Leadership, {name}.', line2: 'Begins the moment you arrive.' },
  { line1: 'A present leader, {name}.', line2: 'Is an engaged leader.' },
  { line1: 'Every check-in, {name}.', line2: 'Is a small act of commitment.' },
  { line1: 'Your attendance, {name}.', line2: 'Speaks before you do.' },
  { line1: 'Being here, {name}.', line2: 'Matters more than you know.' },
  { line1: 'The best leaders, {name}.', line2: 'Are always in the room.' },
  { line1: 'Counted, {name}.', line2: 'Present. Valued.' },
  { line1: 'You\'re here, {name}.', line2: 'That\'s already something.' },
  { line1: 'Present, {name}.', line2: 'And accounted for.' },
  { line1: 'Still showing up, {name}.', line2: 'That\'s the whole game.' },
]

// 0 = morning (5–12), 1 = midday (12–17), 2 = evening (17–21), 3 = night (21–5)
function getWatch(): number {
  const h = new Date().getHours()
  if (h >= 5 && h < 12) return 0
  if (h >= 12 && h < 17) return 1
  if (h >= 17 && h < 21) return 2
  return 3
}

const TIME_POOLS = [MORNING_GREETINGS, MIDDAY_GREETINGS, EVENING_GREETINGS, NIGHT_GREETINGS]

function buildPool(isAdmin: boolean): Greeting[] {
  const timePool = TIME_POOLS[getWatch()]
  const rolePool = isAdmin ? ADMIN_GREETINGS : LEADER_GREETINGS
  return [...timePool, ...rolePool]
}

function getDailyGreeting(isAdmin: boolean): Greeting {
  const pool = buildPool(isAdmin)
  const today = new Date()
  const dateSeed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate()
  const idx = (dateSeed * 4 + getWatch()) % pool.length
  return pool[idx]
}

function HomeGreeting({ user }: { user: AppUser | null }) {
  const isAdmin = !!(user?.isAdmin || user?.isSuperAdmin)
  const { line1, line2 } = getDailyGreeting(isAdmin)
  const firstName = user?.firstName || user?.email?.split('@')[0] || ''
  const dateLabel = format(new Date(), 'EEEE, d MMMM').toUpperCase()

  const [before, after] = line1.split('{name}')

  return (
    <div className='relative px-5 pb-6 pt-5 md:px-6'>
      <PullToRefreshIndicator />
      {/* NavDrawer — renders the persistent desktop sidebar; hamburger is md:hidden inside */}
      <div className='absolute right-5 top-5'>
        <NavDrawer user={user} />
      </div>

      <div className='md:mx-auto md:max-w-5xl'>
        <p className='m-0 mb-3 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground'>
          {dateLabel}
        </p>
        <h1 className='m-0 max-w-[82%] md:max-w-none text-[1.65rem] font-bold leading-tight tracking-tight text-foreground'>
          {before}<span className='text-primary'>{firstName}</span>{after}
          <br />
          {line2}
        </h1>

        <div className='mt-4 flex flex-wrap items-center gap-2'>
          <ChurchScopeSwitcher fallback={
            <span className='rounded-full bg-secondary px-3 py-1 text-xs font-semibold text-foreground'>
              {user?.unitName || 'No assigned church scope'}
            </span>
          } />
          {user?.isSuperAdmin && (
            <span className='rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground'>
              Super Admin
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

type HomeState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ok'; events: CheckinEventRow[] }

// Persist the last-rendered events list per user so cold loads paint instantly
// with the previously-seen data while the network revalidates in the background.
// The Supabase listAllEvents() in-memory cache only lives for the page session;
// this layer survives full reloads / tab restores.
const HOME_CACHE_KEY = 'flc:home:events:v1'
const HOME_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000  // 24h sanity cap

function readPersistedEvents(userId?: string): CheckinEventRow[] | null {
  if (!userId) return null
  try {
    const raw = localStorage.getItem(`${HOME_CACHE_KEY}:${userId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { ts: number; events: CheckinEventRow[] }
    if (!parsed?.events || Date.now() - parsed.ts > HOME_CACHE_MAX_AGE_MS) return null
    return parsed.events
  } catch { return null }
}

function writePersistedEvents(userId: string | undefined, events: CheckinEventRow[]) {
  if (!userId) return
  try {
    localStorage.setItem(
      `${HOME_CACHE_KEY}:${userId}`,
      JSON.stringify({ ts: Date.now(), events }),
    )
  } catch { /* quota / disabled storage */ }
}

function focusCacheSuffix(focusedScope: { level?: string; id?: string } | null | undefined) {
  if (!focusedScope?.level || !focusedScope?.id) return 'all'
  return `${focusedScope.level}:${focusedScope.id}`
}

export default function LeaderHomeScreen() {
  const user = getCurrentUser()
  const navigate = useNavigate()
  const isAdmin = !!(user?.isAdmin || user?.isSuperAdmin)
  const canCreate = canCreateMeetings(user)
  const { focusedScope } = useChurchFocus()
  const homeCacheKey = `${user?.userId ?? 'anon'}:${focusCacheSuffix(focusedScope)}`
  const [state, setState] = useState<HomeState>(() => {
    const cached = readPersistedEvents(homeCacheKey)
    return cached ? { status: 'ok', events: cached } : { status: 'loading' }
  })
  const [refreshKey, setRefreshKey] = useState(0)

  const triggerRefresh = useCallback(() => setRefreshKey((k) => k + 1), [])
  useRefreshSignal(triggerRefresh)

  // Memoised live/upcoming/past split — re-filtering and re-sorting on every
  // unrelated re-render is wasted work once the list is stable.
  const eventGroups = useMemo(() => {
    if (state.status !== 'ok') return null
    const now = new Date()
    const live     = state.events.filter(e => e.status === 'ACTIVE')
    const upcoming = state.events.filter(e => e.status !== 'ACTIVE' && e.status !== 'ENDED' && new Date(e.starts_at) > now)
    const past     = state.events.filter(e => e.status === 'ENDED' || (e.status !== 'ACTIVE' && new Date(e.ends_at) < now))
      .sort((a, b) => new Date(b.ends_at).getTime() - new Date(a.ends_at).getTime())
    return { live, upcoming, past, pastSlice: past.slice(0, 5) }
  }, [state])

  // Cleanup legacy storage from the removed v1 Church-in-Focus key.
  useEffect(() => {
    try { localStorage.removeItem('flc:churchInFocus') } catch { /* ignore */ }
  }, [])

  // Re-seed UI state from cache when the focus changes.
  useEffect(() => {
    const cached = readPersistedEvents(homeCacheKey)
    if (cached) setState({ status: 'ok', events: cached })
    else setState({ status: 'loading' })
  }, [homeCacheKey])

  // Warm the chunks for the screens a leader is most likely to open next
  // (check-in form, event dashboard) once the browser is idle, so tapping an
  // event card never waits on a chunk download. Imports resolve to the same
  // modules React.lazy uses in App.tsx, so there's no double-fetch.
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500))
    const cancelIdle = window.cancelIdleCallback ?? window.clearTimeout
    const handle = idle(() => {
      import('./CheckInFormScreen').catch(() => {})
      import('./admin/EventDashboardScreen').catch(() => {})
    })
    return () => cancelIdle(handle)
  }, [])

  // Warm the data for live events once the list has rendered: getEvent +
  // listCheckedIn are plain Supabase GETs, so prefetching them primes the
  // service worker's stale-while-revalidate cache — opening a live event
  // then paints instantly from cache while revalidating in the background.
  useEffect(() => {
    if (state.status !== 'ok') return
    const liveIds = state.events.filter((e) => e.status === 'ACTIVE').slice(0, 2).map((e) => e.id)
    if (liveIds.length === 0) return
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 2000))
    const cancelIdle = window.cancelIdleCallback ?? window.clearTimeout
    const handle = idle(() => {
      for (const id of liveIds) {
        getEvent(id).catch(() => {})
        listCheckedIn(id).catch(() => {})
      }
    })
    return () => cancelIdle(handle)
  }, [state])

  // Re-fetch whenever the tab becomes visible again (user returns from event edit)
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible') {
        setRefreshKey((k) => k + 1)
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // On re-fetch, keep showing current data while loading (don't flash spinner)
      if (state.status === 'ok') {
        // silent refresh — keep old state visible
      } else {
        setState({ status: 'loading' })
      }
      try {
        // Re-read inside the effect so we pick up any context persisted during
        // a previous async step (e.g. a re-login or a profile fetch below).
        let activeUser = getCurrentUser()

        // FAST PATH: persist the JWT churchScopes synchronously so the events
        // query below has SOMETHING to filter on even if member_profiles
        // hasn't been hydrated yet. This alone unblocks ~70% of accounts.
        persistChurchContextFromJwt((activeUser as any).churchScopes)
        activeUser = getCurrentUser()

        // The JWT only embeds the user's own level; events are filtered by
        // every level in the ancestor chain. If we don't yet have IDs for
        // every ancestor level, hydrate them in PARALLEL with the events
        // query — most leaders get a usable filter from the JWT alone, so
        // we don't need to wait for the profile round-trip.
        const LEVEL_ORDER = ['bacenta','governorship','council','stream','campus','oversight','denomination']
        const ownIdx = activeUser?.level ? LEVEL_ORDER.indexOf(activeUser.level) : -1
        const needsAncestors =
          activeUser?.userId &&
          activeUser.level &&
          LEVEL_ORDER
            .slice(ownIdx >= 0 ? ownIdx : 0)
            .some((lvl) => !(activeUser as any)[lvl]?.id)

        // Snapshot the scope set the first events fetch will use, so after
        // hydration we can tell whether anything actually changed and only
        // re-fetch when it did. This avoids the previous "always 4 calls
        // on cold load" behaviour when the JWT already had what we needed.
        const scopeKeyBefore = scopeFingerprint(activeUser)

        // Kick off both the profile-hydration AND the events fetch concurrently.
        const hydrationPromise = needsAncestors
          ? (async () => {
              try {
                const profile = await getMemberProfile(activeUser!.userId)
                if (profile) {
                  persistChurchContextFromProfileRow(profile)
                  return true
                }
                // Profile not in Supabase yet — fall back to graph.
                const { resolveCurrentMember, memberToProfileRow } = await import('../utils/membersApi')
                const member = await resolveCurrentMember(activeUser)
                if (member) {
                  const row = memberToProfileRow(member)
                  persistChurchContextFromProfileRow(row)
                  // Async-write to Supabase so future sessions skip this fallback.
                  upsertMemberProfile({ ...row, id: activeUser!.userId }).catch(() => {})
                  return true
                }
                return false
              } catch { return false }
            })()
          : Promise.resolve(false)

        const events = await listAllEvents(activeUser ?? undefined, { focusedScope: focusedScope ?? undefined })
        if (cancelled) return
        setState({ status: 'ok', events })
        writePersistedEvents(homeCacheKey, events)

        // Re-fetch ONLY when hydration actually widened the scope set.
        if (needsAncestors) {
          hydrationPromise.then(async (hydrated) => {
            if (!hydrated || cancelled) return
            const freshUser = getCurrentUser()
            const scopeKeyAfter = scopeFingerprint(freshUser)
            if (scopeKeyAfter === scopeKeyBefore) return
            try {
              const events2 = await listAllEvents(freshUser ?? undefined, { focusedScope: focusedScope ?? undefined })
              if (cancelled) return
              setState({ status: 'ok', events: events2 })
              writePersistedEvents(homeCacheKey, events2)
            } catch { /* keep the first-paint state */ }
          })
        }
      } catch (err: any) {
        if (!cancelled) setState({ status: 'error', error: err.message })
      }
    })()
    return () => { cancelled = true }
  }, [refreshKey, focusedScope?.id, focusedScope?.level, homeCacheKey])

  return (
    <PageShell>
      <HomeGreeting user={user} />
      <PageMain>
        {canCreate && (
          <div className='mb-6'>
            <Button type='button' onClick={() => navigate('/admin/events/new')} className='gap-2'>
              <svg viewBox='0 0 24 24' width='16' height='16' fill='currentColor'>
                <path d='M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z' />
              </svg>
              Create Event
            </Button>
          </div>
        )}

        {state.status === 'loading' && <Spinner />}

        {state.status === 'error' && <Alert variant='destructive'>{state.error}</Alert>}

        {state.status === 'ok' && eventGroups && (() => {
          const { live, upcoming, past, pastSlice } = eventGroups

          if (live.length === 0 && upcoming.length === 0 && past.length === 0) {
            return (
              <EmptyState
                title='No events yet'
                description={
                  isAdmin
                    ? 'Create an event to start taking check-ins.'
                    : 'Check-ins will appear here once a leader opens an event.'
                }
                icon={
                  <svg viewBox='0 0 24 24' width='26' height='26' fill='currentColor'>
                    <path d='M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V9h14v11z' />
                  </svg>
                }
                action={
                  canCreate ? (
                    <Button type='button' onClick={() => navigate('/admin/events/new')}>
                      Create event
                    </Button>
                  ) : undefined
                }
              />
            )
          }

          return (
            <div className='flex flex-col gap-8'>

              {/* ── Live ── */}
              {live.length > 0 && (
                <section>
                  <p className='section-heading mb-3 text-success'>Live now</p>
                  <div className='flex flex-col gap-2.5'>
                    {live.map(evt => <EventCard key={evt.id} evt={evt} variant='live' />)}
                  </div>
                </section>
              )}

              {/* ── Upcoming ── */}
              {upcoming.length > 0 && (
                <section>
                  <p className='section-heading mb-3'>Upcoming</p>
                  <div className='flex flex-col gap-2.5'>
                    {upcoming.map(evt => <EventCard key={evt.id} evt={evt} variant='upcoming' />)}
                  </div>
                </section>
              )}

              {/* ── Past (max 5) ── */}
              {pastSlice.length > 0 && (
                <section>
                  <div className='flex items-center justify-between mb-3'>
                    <p className='section-heading m-0'>Recent</p>
                    {past.length > 5 && (
                      <Link
                        to='/history'
                        className='text-xs font-semibold text-primary no-underline hover:underline'
                      >
                        View all history →
                      </Link>
                    )}
                  </div>
                  <div className='flex flex-col gap-2.5'>
                    {pastSlice.map(evt => <EventCard key={evt.id} evt={evt} variant='past' />)}
                  </div>
                  {past.length > 5 && (
                    <Link
                      to='/history'
                      className='mt-3 flex items-center justify-center rounded-lg bg-primary/5 py-2.5 text-xs font-semibold tracking-tight text-primary no-underline hover:bg-primary/10'
                    >
                      + {past.length - 5} more in history
                    </Link>
                  )}
                </section>
              )}

            </div>
          )
        })()}
      </PageMain>
    </PageShell>
  )
}

function EventCard({ evt, variant }: { evt: CheckinEventRow; variant: 'live' | 'upcoming' | 'past' }) {
  const levelColor = `var(--badge-${evt.scope_level}, var(--accent))`
  const statusColor = variant === 'live' ? 'var(--present)' : variant === 'past' ? 'var(--muted)' : levelColor
  const statusLabel = variant === 'live' ? 'Live' : variant === 'past' ? 'Ended' : 'Upcoming'

  return (
    <Link
      to={`/events/${evt.id}`}
      viewTransition
      className={`event-row ${variant === 'past' ? 'opacity-70 shadow-none' : ''}`}
    >
      {/* Leading status dot — replaces the colored side stripe */}
      {variant === 'live' ? (
        <span className='relative flex h-2.5 w-2.5 shrink-0'>
          <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75' />
          <span className='relative inline-flex h-2.5 w-2.5 rounded-full bg-success' />
        </span>
      ) : (
        <span
          className='size-2 shrink-0 rounded-full'
          style={{ background: statusColor }}
        />
      )}

      <div className='min-w-0 flex-1'>
        <p className='m-0 truncate text-sm font-semibold tracking-tight text-foreground'>{evt.name}</p>
        <p className='m-0 mt-0.5 truncate text-xs text-muted-foreground'>
          {evt.scope_church_name}{evt.venue_name ? ` · ${evt.venue_name}` : ''}
        </p>
      </div>
      <div className='shrink-0 text-right'>
        <p className='tnum m-0 text-xs font-semibold text-muted-foreground'>
          {format(new Date(evt.starts_at), 'd MMM')}
        </p>
        <span
          className='text-[10px] font-semibold uppercase tracking-wider'
          style={{ color: statusColor }}
        >
          {statusLabel}
        </span>
      </div>
    </Link>
  )
}

/** Stable string key for the user's full scope set. Used to detect whether
 *  profile hydration actually widened the scope before triggering a second
 *  events fetch. Order is canonical (SCOPE_LEVELS) inside getUserChurchRefs,
 *  so this is a deterministic fingerprint. */
function scopeFingerprint(user: any): string {
  if (!user) return ''
  return getUserChurchRefs(user).map((r) => `${r.level}:${r.id}`).join('|')
}
