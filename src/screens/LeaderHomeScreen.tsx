import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import TopBar from '../components/TopBar'
import Spinner from '../components/Spinner'
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

export default function LeaderHomeScreen() {
  const user = getCurrentUser()
  const navigate = useNavigate()
  const isAdmin = !!(user?.isAdmin || user?.isSuperAdmin)
  const [state, setState] = useState<HomeState>({ status: 'loading' })
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
    <div className='min-h-dvh' style={{ background: 'var(--bg)' }}>
      {/* Pull-to-refresh indicator now lives inside <TopBar /> so every
          screen gets the gesture by default — see PullToRefreshIndicator. */}
      <TopBar
        user={user}
        right={(
          <Link
            to='/events'
            className='px-3 py-1.5'
            style={{
              background: 'var(--bg2)',
              color: 'var(--text)',
              border: '1.5px solid var(--border)',
              borderRadius: 'var(--radius-btn)',
              textDecoration: 'none',
              fontSize: '13px',
              fontWeight: 600,
              letterSpacing: '-0.01em',
            }}
          >
            QR
          </Link>
        )}
      />
      <main className='max-w-5xl mx-auto px-4 sm:px-6 py-6'>

        {isAdmin && (
          <div className='mb-6'>
            <button
              type='button'
              onClick={() => navigate('/admin/events/new')}
              className='btn-pill btn-primary flex items-center gap-2 px-4 py-2.5 font-semibold text-sm cursor-pointer'
            >
              <svg viewBox='0 0 24 24' width='16' height='16' fill='currentColor'>
                <path d='M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z' />
              </svg>
              Create Event
            </button>
          </div>
        )}

        {state.status === 'loading' && <Spinner />}

        {state.status === 'error' && (
          <div
            className='p-4 text-sm'
            style={{
              background: 'rgba(232,96,74,0.08)',
              color: 'var(--coral)',
              border: '1px solid rgba(232,96,74,0.25)',
              borderRadius: 'var(--radius-btn)',
            }}
          >
            {state.error}
          </div>
        )}

        {state.status === 'ok' && (() => {
          const now = new Date()
          const live     = state.events.filter(e => e.status === 'ACTIVE' && new Date(e.starts_at) <= now && new Date(e.ends_at) >= now)
          const upcoming = state.events.filter(e => new Date(e.starts_at) > now && e.status !== 'ENDED')
          const past     = state.events.filter(e => new Date(e.ends_at) < now || e.status === 'ENDED')
            .sort((a, b) => new Date(b.ends_at).getTime() - new Date(a.ends_at).getTime())
          const pastSlice = past.slice(0, 5)

          if (live.length === 0 && upcoming.length === 0 && past.length === 0) {
            return (
              <div className='p-8 text-center' style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-card)' }}>
                <p className='text-sm m-0' style={{ color: 'var(--muted)' }}>No events found.</p>
              </div>
            )
          }

          return (
            <div className='flex flex-col gap-8'>

              {/* ── Live ── */}
              {live.length > 0 && (
                <section>
                  <p className='eyebrow mb-3' style={{ color: 'var(--green)' }}>Live</p>
                  <div className='flex flex-col gap-2.5'>
                    {live.map(evt => <EventCard key={evt.id} evt={evt} variant='live' />)}
                  </div>
                </section>
              )}

              {/* ── Upcoming ── */}
              {upcoming.length > 0 && (
                <section>
                  <p className='eyebrow mb-3'>Upcoming</p>
                  <div className='flex flex-col gap-2.5'>
                    {upcoming.map(evt => <EventCard key={evt.id} evt={evt} variant='upcoming' />)}
                  </div>
                </section>
              )}

              {/* ── Past (max 5) ── */}
              {pastSlice.length > 0 && (
                <section>
                  <div className='flex items-center justify-between mb-3'>
                    <p className='eyebrow m-0'>Recent</p>
                    {past.length > 5 && (
                      <Link
                        to='/admin/history'
                        className='text-xs font-semibold'
                        style={{ color: 'var(--accent)', textDecoration: 'none', letterSpacing: '-0.01em' }}
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
                      className='mt-3 flex items-center justify-center text-xs font-semibold py-2.5'
                      style={{
                        color: 'var(--muted)',
                        textDecoration: 'none',
                        border: '1px dashed var(--border)',
                        borderRadius: 'var(--radius-btn)',
                        letterSpacing: '-0.01em',
                      }}
                    >
                      + {past.length - 5} more in history
                    </Link>
                  )}
                </section>
              )}

            </div>
          )
        })()}
      </main>
    </div>
  )
}

function EventCard({ evt, variant }: { evt: CheckinEventRow; variant: 'live' | 'upcoming' | 'past' }) {
  const levelColor = `var(--badge-${evt.scope_level}, var(--accent))`
  const stripeColor = variant === 'past' ? 'var(--border)' : variant === 'live' ? 'var(--green)' : levelColor
  const statusColor = variant === 'live' ? 'var(--green)' : variant === 'past' ? 'var(--muted)' : levelColor
  const statusLabel = variant === 'live' ? 'Live' : variant === 'past' ? 'Ended' : 'Upcoming'

  return (
    <Link
      to={`/events/${evt.id}`}
      className='flex transition-all hover:brightness-105 active:scale-[0.99]'
      style={{
        background: 'var(--card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-card)',
        textDecoration: 'none',
        overflow: 'hidden',
        boxShadow: variant === 'past' ? 'none' : 'var(--shadow-2)',
        opacity: variant === 'past' ? 0.65 : 1,
      }}
    >
      <div style={{ width: 4, background: stripeColor, flexShrink: 0 }} />
      <div className='px-4 py-3 flex-1 min-w-0 flex items-center justify-between gap-3'>
        <div className='min-w-0'>
          <div className='flex items-center gap-1.5 min-w-0'>
            {variant === 'live' && (
              <span className='relative flex h-2 w-2 shrink-0'>
                <span className='animate-ping absolute inline-flex h-full w-full rounded-full opacity-75' style={{ background: 'var(--green)' }} />
                <span className='relative inline-flex rounded-full h-2 w-2' style={{ background: 'var(--green)' }} />
              </span>
            )}
            <p className='text-sm font-bold m-0 truncate' style={{ color: 'var(--text)', letterSpacing: '-0.02em' }}>{evt.name}</p>
          </div>
          <p className='text-xs m-0 mt-0.5 truncate' style={{ color: 'var(--muted)' }}>
            {evt.scope_church_name}{evt.venue_name ? ` · ${evt.venue_name}` : ''}
          </p>
        </div>
        <div className='shrink-0 text-right'>
          <p className='text-xs font-bold m-0' style={{ color: 'var(--muted)' }}>
            {format(new Date(evt.starts_at), 'd MMM')}
          </p>
          <span className='text-[10px] font-bold uppercase' style={{ color: statusColor, letterSpacing: '0.06em' }}>
            {statusLabel}
          </span>
        </div>
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
