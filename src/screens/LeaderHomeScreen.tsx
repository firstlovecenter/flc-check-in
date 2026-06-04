import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import TopBar from '../components/TopBar'
import Spinner from '../components/Spinner'
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
import type { CheckinEventRow } from '../types/app'

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
      <TopBar
        user={user}
        right={(
          <Link to='/events' className='btn-pill btn-secondary px-3 py-1.5 text-xs no-underline'>
            QR
          </Link>
        )}
      />
      <PageMain>
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
