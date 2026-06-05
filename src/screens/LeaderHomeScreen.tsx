import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import Spinner from '../components/Spinner'
import NavDrawer from '../components/NavDrawer'
import PullToRefreshIndicator from '../components/PullToRefreshIndicator'
import { PageShell, PageMain } from '../components/layout/PageShell'
import { EmptyState } from '../components/layout/EmptyState'
import { Alert } from '../components/ui/alert'
import { Button } from '../components/ui/button'
import { getCurrentUser, persistChurchContextFromProfileRow, persistChurchContextFromJwt } from '../utils/auth'
import {
  listAllEvents, getMemberProfile, upsertMemberProfile,
} from '../utils/supabaseCheckins'
import { useRefreshSignal } from '../hooks/useRefreshSignal'
import { getUserChurchRefs } from '../utils/userScope'
import type { AppUser, CheckinEventRow } from '../types/app'

const ADMIN_GREETINGS = [
  'the harvest is plentiful — let\'s make sure every leader is accounted for.',
  'Hineni means "here I am" — let\'s see which leaders answer today.',
  'every leader on the list matters. Let\'s check them in.',
  'the doors are open. Which leaders are showing up?',
  'faithful and present — that\'s the standard for every leader. Let\'s track it.',
  'today\'s leader attendance starts with you being here.',
  'the roll has been called — let\'s see which leaders answer.',
  'every check-in tells a story. Let\'s write today\'s.',
  'a good overseer knows their leaders. Let\'s count them in.',
  'presence is the first proof of a leader\'s commitment.',
  'which leaders said yes today? Let\'s find out.',
  'the work begins when the leaders arrive.',
  'leader accountability starts here — one check-in at a time.',
  'you can\'t develop leaders who don\'t show up.',
  'faithfulness is trackable. Let\'s track it.',
  'every leader present is a win. Let\'s count them.',
  'the record doesn\'t lie — let\'s make sure every leader is in.',
  'which leaders answered the call today?',
  'showing up is non-negotiable for leaders. Let\'s hold the standard.',
  'the fields need leaders who show up. Let\'s see who\'s in.',
]

const LEADER_GREETINGS = [
  'every meeting starts with showing up... and on time.',
  'your presence as a leader matters — let\'s mark it.',
  'Hineni — here I am. Ready to be counted.',
  'faithfulness is showing up, every single time.',
  'the harvest needs leaders who show up.',
  'present and accounted for — that\'s the goal.',
  'Hineni — the answer that changes everything.',
  'your seat is waiting. Don\'t leave it empty.',
  'consistency builds character. Show up again today.',
  'your presence is your vote of confidence in the vision.',
  'be where you\'re supposed to be, when you\'re supposed to be there.',
  'early is on time. On time is late. You know the standard.',
  'leaders show up — every part of the body matters.',
  'another day, another chance to be counted faithful.',
  'the register is open. Let your name be found.',
  'here and ready — that\'s all it takes to start.',
  'someone is always watching how leaders show up.',
  'your commitment shows up before you do.',
  'check in — let them know their leader is here.',
  'small faithfulness, big impact. Start by showing up.',
]

const MORNING_GREETINGS = [
  'the morning belongs to those who show up early.',
  'rise and be counted — the day is just starting.',
  'a new morning, a fresh chance to be faithful.',
  'the early bird gets checked in.',
  'good things happen when you start the day present.',
  'the morning watch is set. Are you in position?',
]

const MIDDAY_GREETINGS = [
  'the midday watch — still showing up. That\'s the standard.',
  'halfway through the day and still faithful. Keep going.',
  'the afternoon session needs you here.',
  'midday and still showing up — that\'s dedication.',
  'the day isn\'t over and neither is your faithfulness.',
  'noon check-in — still counts, always matters.',
]

const EVENING_GREETINGS = [
  'the evening watch is open. Be where you need to be.',
  'evening meetings matter too — and so does your presence.',
  'the day winds down, but faithfulness doesn\'t.',
  'end the day where you\'re supposed to be.',
  'showing up in the evening takes extra commitment. Noted.',
  'the third watch — faithful to the end of the day.',
]

const NIGHT_GREETINGS = [
  'the fourth watch — and still you show up. Remarkable.',
  'night meetings demand a different kind of commitment. You have it.',
  'the night watch is for the truly dedicated. Welcome.',
  'darkness doesn\'t stop the faithful from showing up.',
  'even at this hour, presence matters.',
  'the night belongs to those who refuse to be absent.',
]

function getWatch(): number {
  const hour = new Date().getHours()
  if (hour >= 5 && hour < 12) return 0   // morning watch
  if (hour >= 12 && hour < 17) return 1  // midday watch
  if (hour >= 17 && hour < 21) return 2  // evening watch
  return 3                                // night watch
}

function getTimePool(): string[] {
  const watch = getWatch()
  if (watch === 0) return MORNING_GREETINGS
  if (watch === 1) return MIDDAY_GREETINGS
  if (watch === 2) return EVENING_GREETINGS
  return NIGHT_GREETINGS
}

function buildPool(isAdmin: boolean, isLeader: boolean): string[] {
  const pool: string[] = [...getTimePool()]
  if (isLeader) pool.push(...LEADER_GREETINGS)
  if (isAdmin) pool.push(...ADMIN_GREETINGS)
  return pool
}

function getDailyGreeting(isAdmin: boolean, isLeader: boolean): string {
  const pool = buildPool(isAdmin, isLeader)
  const now = new Date()
  const dateSeed = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate()
  const seed = dateSeed * 4 + getWatch()
  return pool[seed % pool.length]
}

function HomeGreeting({ user }: { user: AppUser | null }) {
  const firstName = user?.firstName || 'Friend'
  const isAdmin = !!(user?.isAdmin || user?.isSuperAdmin)
  const isLeader = !!(user?.roles?.length)
  const now = new Date()
  const dateLabel = format(now, 'EEEE d MMMM').toUpperCase()

  const chips: string[] = []
  if (user?.unitName) chips.push(user.unitName)
  if (user?.level) chips.push(user.level.charAt(0).toUpperCase() + user.level.slice(1))
  if (user?.isAdmin) chips.push('Admin')
  if (user?.isSuperAdmin) chips.push('Super Admin')

  return (
    <div className='relative mb-6 px-1'>
      <PullToRefreshIndicator />
      <div className='absolute right-0 top-0'>
        <NavDrawer user={user} />
      </div>
      <p className='m-0 mb-1 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground'>
        {dateLabel}
      </p>
      <h1 className='m-0 text-2xl font-bold leading-tight text-foreground'>
        <span className='text-primary'>{firstName}</span>
        {', '}
        {getDailyGreeting(isAdmin, isLeader)}
      </h1>
      {chips.length > 0 && (
        <div className='mt-3 flex flex-wrap gap-1.5'>
          {chips.map((chip) => (
            <span
              key={chip}
              className='rounded-full border border-border px-2.5 py-0.5 text-xs font-medium text-muted-foreground'
            >
              {chip}
            </span>
          ))}
        </div>
      )}
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

export default function LeaderHomeScreen() {
  const user = getCurrentUser()
  const navigate = useNavigate()
  const isAdmin = !!(user?.isAdmin || user?.isSuperAdmin)
  const [state, setState] = useState<HomeState>(() => {
    const cached = readPersistedEvents(user?.userId)
    return cached ? { status: 'ok', events: cached } : { status: 'loading' }
  })
  const [refreshKey, setRefreshKey] = useState(0)

  const triggerRefresh = useCallback(() => setRefreshKey((k) => k + 1), [])
  // Pull-to-refresh AND the TopBar refresh button both publish to the global
  // refresh signal — see PullToRefreshIndicator / RefreshButton.
  useRefreshSignal(triggerRefresh)

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
      if (refreshKey > 0 && state.status === 'ok') {
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

        const events = await listAllEvents(activeUser ?? undefined)
        if (cancelled) return
        setState({ status: 'ok', events })
        writePersistedEvents(activeUser?.userId, events)

        // Re-fetch ONLY when hydration actually widened the scope set.
        if (needsAncestors) {
          hydrationPromise.then(async (hydrated) => {
            if (!hydrated || cancelled) return
            const freshUser = getCurrentUser()
            const scopeKeyAfter = scopeFingerprint(freshUser)
            if (scopeKeyAfter === scopeKeyBefore) return
            try {
              const events2 = await listAllEvents(freshUser ?? undefined)
              if (cancelled) return
              setState({ status: 'ok', events: events2 })
              writePersistedEvents(freshUser?.userId, events2)
            } catch { /* keep the first-paint state */ }
          })
        }
      } catch (err: any) {
        if (!cancelled) setState({ status: 'error', error: err.message })
      }
    })()
    return () => { cancelled = true }
  }, [refreshKey])

  return (
    <PageShell>
      <PageMain>
        <HomeGreeting user={user} />
        {isAdmin && (
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

        {state.status === 'ok' && (() => {
          const now = new Date()
          const live     = state.events.filter(e => e.status === 'ACTIVE' && new Date(e.starts_at) <= now && new Date(e.ends_at) >= now)
          const upcoming = state.events.filter(e => new Date(e.starts_at) > now && e.status !== 'ENDED')
          const past     = state.events.filter(e => new Date(e.ends_at) < now || e.status === 'ENDED')
            .sort((a, b) => new Date(b.ends_at).getTime() - new Date(a.ends_at).getTime())
          const pastSlice = past.slice(0, 5)

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
                  isAdmin ? (
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
                        to='/admin/history'
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
                      to='/admin/history'
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
