import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { format } from 'date-fns'
import Spinner from '../components/Spinner'
import NavDrawer from '../components/NavDrawer'
import LanguageSwitcher from '../components/LanguageSwitcher'
import PullToRefreshIndicator from '../components/PullToRefreshIndicator'
import { PageShell, PageMain } from '../components/layout/PageShell'
import { EmptyState } from '../components/layout/EmptyState'
import { Alert } from '../components/ui/alert'
import { Button } from '../components/ui/button'
import ChurchScopeSwitcher from '../components/ChurchScopeSwitcher'
import { canCreateMeetings, getCurrentUser, persistChurchContextFromProfileRow, persistChurchContextFromJwt } from '../utils/auth'
import {
  listAllEvents, getMemberProfile, upsertMemberProfile,
  getEvent,
} from '../utils/supabaseCheckins'
import { useRefreshSignal } from '../hooks/useRefreshSignal'
import { getUserChurchRefs } from '../utils/userScope'
import { useChurchFocus } from '../contexts/ChurchFocusContext'
import { friendlyErrorMessage } from '../utils/network'
import type { AppUser, CheckinEventRow } from '../types/app'

type Greeting = { line1: string; line2: string }

// 0 = morning (5–12), 1 = midday (12–17), 2 = evening (17–21), 3 = night (21–5)
function getWatch(): number {
  const h = new Date().getHours()
  if (h >= 5 && h < 12) return 0
  if (h >= 12 && h < 17) return 1
  if (h >= 17 && h < 21) return 2
  return 3
}

function asGreetingPool(value: unknown): Greeting[] {
  return Array.isArray(value) ? (value as Greeting[]) : []
}

function buildPool(isAdmin: boolean, t: (key: string, opts?: { returnObjects?: boolean }) => string | object): Greeting[] {
  const timePools = [
    asGreetingPool(t('greetings.morning', { returnObjects: true })),
    asGreetingPool(t('greetings.midday', { returnObjects: true })),
    asGreetingPool(t('greetings.evening', { returnObjects: true })),
    asGreetingPool(t('greetings.night', { returnObjects: true })),
  ]
  const timePool = timePools[getWatch()]
  const rolePool = asGreetingPool(isAdmin
    ? t('greetings.admin', { returnObjects: true })
    : t('greetings.leader', { returnObjects: true }))
  return [...timePool, ...rolePool]
}

function getDailyGreeting(isAdmin: boolean, t: (key: string, opts?: { returnObjects?: boolean }) => string | object): Greeting {
  const pool = buildPool(isAdmin, t)
  if (pool.length === 0) return { line1: t('common.welcome') as string, line2: '' }
  const today = new Date()
  const dateSeed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate()
  const idx = (dateSeed * 4 + getWatch()) % pool.length
  return pool[idx]
}

function HomeGreeting({ user }: { user: AppUser | null }) {
  const { t } = useTranslation()
  const isAdmin = !!(user?.isAdmin || user?.isSuperAdmin)
  const { line1, line2 } = getDailyGreeting(isAdmin, t)
  const firstName = user?.firstName || user?.email?.split('@')[0] || ''
  const dateLabel = format(new Date(), 'EEEE, d MMMM').toUpperCase()

  const [before, after] = line1.split('{{name}}')

  return (
    <div className='relative px-5 pb-6 pt-5 md:px-6'>
      <PullToRefreshIndicator />
      <NavDrawer user={user} />

      <div className='md:mx-auto md:max-w-5xl'>
        <div className='mb-3 flex items-start justify-between gap-3'>
          <p className='m-0 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground'>
            {dateLabel}
          </p>
          <LanguageSwitcher className='shrink-0' />
        </div>
        <h1 className='m-0 max-w-[82%] md:max-w-none text-[1.65rem] font-bold leading-tight tracking-tight text-foreground'>
          {before}<span className='text-primary'>{firstName}</span>{after}
          <br />
          {line2}
        </h1>

        {/* The role chip is the only badge here. A separate "Super Admin"
            label used to sit alongside it, but superadmin is not a scope you
            act under — it is a privilege that widens whichever hat you are
            wearing. Showing it as a peer of the role chip implied it was
            another selectable identity. */}
        <div className='mt-4 flex flex-wrap items-center gap-2'>
          <ChurchScopeSwitcher fallback={
            <span className='rounded-full bg-secondary px-3 py-1 text-xs font-semibold text-foreground'>
              {user?.unitName || t('home.noAssignedScope')}
            </span>
          } />
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
    if (
      typeof parsed?.ts !== 'number' ||
      !Array.isArray(parsed.events) ||
      Date.now() - parsed.ts > HOME_CACHE_MAX_AGE_MS
    ) return null
    const events = parsed.events.filter(isRenderableEvent)
    return events.length ? events : null
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

function isRenderableEvent(evt: Partial<CheckinEventRow> | null | undefined): evt is CheckinEventRow {
  return !!(
    evt &&
    typeof evt.id === 'string' &&
    typeof evt.name === 'string' &&
    typeof evt.status === 'string'
  )
}

function formatEventDate(value: string | null | undefined, tbdLabel: string): string {
  const date = new Date(value ?? '')
  if (Number.isNaN(date.getTime())) return tbdLabel
  return format(date, 'd MMM')
}

export default function LeaderHomeScreen() {
  const { t } = useTranslation()
  const user = getCurrentUser()
  const navigate = useNavigate()
  const isAdmin = !!(user?.isAdmin || user?.isSuperAdmin)
  const canCreate = canCreateMeetings(user)
  const { focusedScope, focusedHat, isMultiRole } = useChurchFocus()
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
    return { live, upcoming, past }
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

  // Warm the event detail for live events once the list has rendered, so
  // opening one paints from the service worker's cache while it revalidates.
  //
  // This deliberately does NOT prefetch listCheckedIn any more. That call
  // pages through EVERY check-in record for the event, and nothing on the home
  // screen renders records — so the cost was pure waste, scaling as
  // (viewers x attendees) and re-firing on every visibilitychange, i.e. every
  // screen unlock and app switch. On a 1,000-attendee event with 1,000 leaders
  // that is a million rows moved per refresh cycle, which on Supabase's
  // metered egress is a bill as well as a latency problem.
  useEffect(() => {
    if (state.status !== 'ok') return
    const liveIds = state.events.filter((e) => e.status === 'ACTIVE').slice(0, 2).map((e) => e.id)
    if (liveIds.length === 0) return
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 2000))
    const cancelIdle = window.cancelIdleCallback ?? window.clearTimeout
    const handle = idle(() => {
      for (const id of liveIds) {
        getEvent(id).catch(() => {})
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
        if (!cancelled) setState({ status: 'error', error: friendlyErrorMessage(err) })
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
              {t('home.createEvent')}
            </Button>
          </div>
        )}

        {state.status === 'loading' && <Spinner />}

        {state.status === 'error' && <Alert variant='destructive'>{state.error}</Alert>}

        {state.status === 'ok' && eventGroups && (() => {
          const { live, upcoming, past } = eventGroups

          if (live.length === 0 && upcoming.length === 0 && past.length === 0) {
            return (
              <EmptyState
                kind='no-scope'
                // An empty home used to be a dead end. Now that the list is
                // scoped to ONE role, "nothing here" is usually "nothing here
                // for THIS role" — so name the role and point at the switcher
                // rather than implying there are no events at all.
                title={focusedHat ? t('home.noEventsFor', { name: focusedHat.name }) : t('home.noEventsTitle')}
                description={
                  isMultiRole && focusedHat
                    ? t('home.noEventsMultiRole', { role: focusedHat.roleLabel })
                    : isAdmin
                      ? t('home.noEventsAdmin')
                      : t('home.noEventsLeader')
                }
                icon={
                  <svg viewBox='0 0 24 24' width='26' height='26' fill='currentColor'>
                    <path d='M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V9h14v11z' />
                  </svg>
                }
                action={
                  canCreate ? (
                    <Button type='button' onClick={() => navigate('/admin/events/new')}>
                      {t('home.createEvent')}
                    </Button>
                  ) : undefined
                }
              />
            )
          }

          return (
            <div className='flex flex-col gap-8'>

              {/* Home is an action surface: emphasize what needs attention now. */}
              {live.length > 0 && (
                <section>
                  <p className='section-heading mb-3 text-success'>{t('home.liveNow')}</p>
                  <div className='flex flex-col gap-2.5'>
                    <LiveEventHero evt={live[0]} />
                    {live.slice(1, 3).map(evt => <EventCard key={evt.id} evt={evt} variant='live' />)}
                  </div>
                </section>
              )}

              {/* ── Upcoming ── */}
              {upcoming.length > 0 && (
                <section>
                  <p className='section-heading mb-3'>{t('home.upcoming')}</p>
                  <div className='flex flex-col gap-2.5'>
                    {upcoming.slice(0, 1).map(evt => <EventCard key={evt.id} evt={evt} variant='upcoming' />)}
                  </div>
                </section>
              )}

              {/* ── Past ── */}
              {past.length > 0 && (
                <section>
                  <div className='flex items-center justify-between mb-3'>
                    <p className='section-heading m-0'>{t('home.recent')}</p>
                    <Link
                      to='/app/events?view=past'
                      className='text-xs font-semibold text-primary no-underline hover:underline'
                    >
                      {t('home.viewPastEvents')}
                    </Link>
                  </div>
                  <div className='flex flex-col gap-2.5'>
                    {past.slice(0, 2).map(evt => <EventCard key={evt.id} evt={evt} variant='past' />)}
                  </div>
                </section>
              )}

            </div>
          )
        })()}
      </PageMain>
    </PageShell>
  )
}

function LiveEventHero({ evt }: { evt: CheckinEventRow }) {
  const { t } = useTranslation()
  return (
    <div className='overflow-hidden rounded-2xl border border-success/25 bg-card shadow-sm'>
      <div className='flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs font-semibold text-success'>
        <span className='size-2 rounded-full bg-success' aria-hidden />
        {t('home.checkInOpen')}
      </div>
      <div className='p-4 sm:p-5'>
        <h2 className='m-0 text-lg font-semibold tracking-tight text-foreground'>{evt.name}</h2>
        <p className='m-0 mt-1 text-sm text-muted-foreground'>{evt.scope_church_name}{evt.venue_name ? ` · ${evt.venue_name}` : ''}</p>
        <p className='m-0 mt-2 text-xs text-muted-foreground'>{t('home.closes', { date: formatEventDate(evt.ends_at, t('home.tbd')) })}</p>
        <div className='mt-4 flex gap-2'>
          <Link to={`/checkin/${evt.id}`} className='btn-pill btn-primary flex min-h-11 flex-1 items-center justify-center px-4 text-sm font-semibold no-underline active:scale-[0.98]'>{t('home.checkInNow')}</Link>
          <Link to={`/events/${evt.id}`} className='btn-pill btn-secondary flex min-h-11 items-center justify-center px-4 text-sm font-semibold no-underline active:scale-[0.98]'>{t('home.details')}</Link>
        </div>
      </div>
    </div>
  )
}

function EventCard({ evt, variant }: { evt: CheckinEventRow; variant: 'live' | 'upcoming' | 'past' }) {
  const { t } = useTranslation()
  const levelColor = `var(--badge-${evt.scope_level}, var(--accent))`
  const statusColor = variant === 'live' ? 'var(--present)' : variant === 'past' ? 'var(--muted)' : levelColor
  const statusLabel = variant === 'live' ? t('home.statusLive') : variant === 'past' ? t('home.statusEnded') : t('home.statusUpcoming')

  return (
    <Link
      to={`/events/${evt.id}`}
      viewTransition
      className={`event-row ${variant === 'past' ? 'opacity-70 shadow-none' : ''}`}
    >
      {/* Leading status dot — replaces the colored side stripe */}
      {variant === 'live' ? (
        <span className='h-2.5 w-2.5 shrink-0 rounded-full bg-success' />
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
          {formatEventDate(evt.starts_at, t('home.tbd'))}
        </p>
        <span
          className='text-[11px] font-semibold uppercase tracking-wider'
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
