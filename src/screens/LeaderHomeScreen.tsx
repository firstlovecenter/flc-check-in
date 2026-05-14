import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { format } from 'date-fns'
import TopBar from '../components/TopBar'
import EventCardForLeader from '../components/checkin/EventCardForLeader'
import { getCurrentUser, persistChurchContextFromProfileRow } from '../utils/auth'
import {
  listActiveEvents, listRecentPastEvents, getMemberProfile,
} from '../utils/supabaseCheckins'
import { usePullToRefresh } from '../hooks/usePullToRefresh'
import type { CheckinEventRow } from '../types/app'

type HomeState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ok'; active: CheckinEventRow[]; past: CheckinEventRow[] }

export default function LeaderHomeScreen() {
  const user = getCurrentUser()
  const [state, setState] = useState<HomeState>({ status: 'loading' })
  const [refreshKey, setRefreshKey] = useState(0)

  const triggerRefresh = useCallback(() => setRefreshKey((k) => k + 1), [])
  const { pullDistance, refreshing } = usePullToRefresh({ onRefresh: triggerRefresh })

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

        // If the JWT didn't embed the church ID for this user's level (common
        // for denomination-level leaders), try to recover it from member_profiles
        // (written during login sync) and persist it to localStorage so that
        // subsequent page loads don't need this round-trip.
        if (
          activeUser?.userId &&
          activeUser.level &&
          !(activeUser as any)[activeUser.level]?.id
        ) {
          try {
            const profile = await getMemberProfile(activeUser.userId)
            if (profile?.[`${activeUser.level}_id`]) {
              persistChurchContextFromProfileRow(profile)
              activeUser = getCurrentUser() // re-read with freshly persisted context
            }
          } catch { /* non-critical — proceed with whatever we have */ }
        }

        const [active, past] = await Promise.all([
          listActiveEvents(activeUser ?? undefined),
          listRecentPastEvents({ user: activeUser ?? undefined }),
        ])
        if (cancelled) return
        setState({ status: 'ok', active, past })
      } catch (err: any) {
        if (!cancelled) setState({ status: 'error', error: err.message })
      }
    })()
    return () => { cancelled = true }
  }, [refreshKey])

  return (
    <div className='min-h-dvh' style={{ background: 'var(--bg)' }}>
      {/* Pull-to-refresh indicator */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: `${pullDistance}px`,
          overflow: 'hidden',
          zIndex: 50,
          pointerEvents: 'none',
          transition: pullDistance === 0 ? 'height 0.2s ease' : 'none',
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            border: '2.5px solid var(--accent)',
            borderTopColor: 'transparent',
            opacity: refreshing ? 1 : pullDistance / (72),
            animation: refreshing ? 'spin 0.7s linear infinite' : 'none',
            transform: refreshing ? 'none' : `rotate(${pullDistance * 3}deg)`,
          }}
        />
      </div>
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
        <p className='eyebrow mb-3'>
          Upcoming / Current Events
        </p>

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

        {state.status === 'ok' && state.active.length === 0 && (
          <div
            className='p-8 text-center'
            style={{
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-card)',
            }}
          >
            <p className='text-sm m-0' style={{ color: 'var(--muted)' }}>
              No active events right now.
            </p>
          </div>
        )}

        {state.status === 'ok' && state.active.length > 0 && (
          <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3'>
            {state.active.map((evt) => <EventCardForLeader key={evt.id} event={evt} />)}
          </div>
        )}

        {state.status === 'ok' && state.past.length > 0 && (
          <>
            <div className='my-6' style={{ borderTop: '1px solid var(--border)' }} />
            <p className='eyebrow mb-3'>Past Events</p>
            <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2'>
              {state.past.map((evt) => (
                <Link
                  key={evt.id}
                  to={`/events/${evt.id}`}
                  className='block p-4 transition-opacity'
                  style={{
                    background: 'var(--card)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-btn)',
                    textDecoration: 'none',
                    opacity: 0.6,
                  }}
                >
                  <div className='flex items-start justify-between gap-3'>
                    <div className='min-w-0'>
                      <p className='text-sm font-semibold m-0 truncate' style={{ color: 'var(--text)' }}>{evt.name}</p>
                      <p className='text-xs m-0 mt-0.5 truncate' style={{ color: 'var(--muted)' }}>
                        {evt.scope_church_name}
                        {evt.venue_name ? ` · ${evt.venue_name}` : ''}
                        {' · '}{format(new Date(evt.starts_at), 'PP')}
                      </p>
                    </div>
                    <span
                      className='text-[10px] px-2.5 py-1 uppercase font-bold tracking-wider shrink-0'
                      style={{ background: 'var(--bg2)', color: 'var(--muted)', borderRadius: 'var(--radius-pill)', letterSpacing: '0.06em' }}
                    >
                      Ended
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  )
}
