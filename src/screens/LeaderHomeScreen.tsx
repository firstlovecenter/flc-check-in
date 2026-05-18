import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { format } from 'date-fns'
import TopBar from '../components/TopBar'
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
        <p className='eyebrow mb-3'>Events</p>

        {state.status === 'loading' && (
          <p className='text-sm' style={{ color: 'var(--muted)' }}>Loading events…</p>
        )}

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

        {state.status === 'ok' && state.events.length === 0 && (
          <div
            className='p-8 text-center'
            style={{
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-card)',
            }}
          >
            <p className='text-sm m-0' style={{ color: 'var(--muted)' }}>No events found.</p>
          </div>
        )}

        {state.status === 'ok' && state.events.length > 0 && (
          <div className='flex flex-col gap-2.5'>
            {state.events.map((evt) => {
              const now = new Date()
              const starts = new Date(evt.starts_at)
              const ends = new Date(evt.ends_at)
              const isLive = evt.status === 'ACTIVE' && starts <= now && ends >= now
              const isPast = ends < now || evt.status === 'ENDED'
              const isFuture = starts > now && evt.status !== 'ENDED'
              const levelColor = `var(--badge-${evt.scope_level}, var(--accent))`
              const stripeColor = isPast ? 'var(--border)' : levelColor

              return (
                <Link
                  key={evt.id}
                  to={`/events/${evt.id}`}
                  className='flex transition-all hover:brightness-105 active:scale-[0.99]'
                  style={{
                    background: 'var(--card)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-card)',
                    textDecoration: 'none',
                    overflow: 'hidden',
                    boxShadow: isPast ? 'none' : 'var(--shadow-2)',
                    opacity: isPast ? 0.6 : 1,
                  }}
                >
                  <div style={{ width: 4, background: stripeColor, flexShrink: 0 }} />
                  <div className='px-4 py-3 flex-1 min-w-0 flex items-center justify-between gap-3'>
                    <div className='min-w-0'>
                      <div className='flex items-center gap-1.5 min-w-0'>
                        {isLive && (
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
                      <span
                        className='text-[10px] font-bold uppercase tracking-wider'
                        style={{
                          color: isLive ? 'var(--green)' : isPast ? 'var(--muted)' : levelColor,
                          letterSpacing: '0.06em',
                        }}
                      >
                        {isLive ? 'Live' : isPast ? 'Ended' : isFuture ? 'Upcoming' : evt.status}
                      </span>
                    </div>
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </main>
    </div>
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
