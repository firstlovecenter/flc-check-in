// QR display — public AND in-app.
// Anonymous viewers (device mounted at the venue) see a chromeless display.
// Authenticated viewers (coming from the hamburger menu) get a ScreenHeader
// with the menu and a back link so they don't feel trapped.

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import QRCodeDisplay from '../components/checkin/QRCodeDisplay'
import ScreenHeader from '../components/ScreenHeader'
import { listActiveEvents, listActiveSpecialGroupEventsForUser } from '../utils/supabaseCheckins'
import Spinner from '../components/Spinner'
import { generateQrToken, currentBucket, generateRotatingPin } from '../utils/checkinsCrypto'
import { formatDistanceToNowStrict } from 'date-fns'
import type { CheckinEventRow } from '../types/app'
import { getCurrentUser } from '../utils/auth'

type QRState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ok'; events: CheckinEventRow[] }

// Detect "signed-in" via the same source of truth the rest of the app uses.
function isSignedIn() {
  return !!localStorage.getItem('accessToken')
}

const REFRESH_INTERVAL_MS = 30_000

function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    typeof window !== 'undefined'
      ? (localStorage.getItem('flc-theme') as 'dark' | 'light') || 'light'
      : 'light'
  )
  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    localStorage.setItem('flc-theme', next)
    if (next === 'dark') document.documentElement.setAttribute('data-theme', 'dark')
    else document.documentElement.removeAttribute('data-theme')
  }
  return { theme, toggle }
}

export default function QRDisplayScreen() {
  const [state, setState] = useState<QRState>({ status: 'loading' })
  const [selected, setSelected] = useState<CheckinEventRow | null>(null)
  const [search, setSearch] = useState('')
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const user = isSignedIn() ? getCurrentUser() : null
        // Superadmins see all events (including all special-group events) via
        // listActiveEvents(user). Everyone else gets public events + only the
        // special-group events for groups they personally belong to.
        let events: any[]
        if (user?.isSuperAdmin) {
          events = await listActiveEvents(user)
        } else {
          const [publicEvents, groupEvents] = await Promise.all([
            listActiveEvents(),
            user?.userId ? listActiveSpecialGroupEventsForUser(user.userId) : Promise.resolve([]),
          ])
          const seen = new Set<string>()
          events = [...publicEvents, ...groupEvents].filter((e) => {
            if (seen.has(e.id)) return false
            seen.add(e.id)
            return true
          })
        }
        if (cancelled) return
        setState({ status: 'ok', events })
        // Auto-select when there's exactly one event
        if (events.length === 1) setSelected(events[0])
      } catch (err: any) {
        if (!cancelled) setState({ status: 'error', error: err.message })
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])

  const signedIn = isSignedIn()
  const { theme, toggle: toggleTheme } = useTheme()
  const filteredEvents = useMemo(() => {
    if (state.status !== 'ok') return [] as CheckinEventRow[]
    const q = search.trim().toLowerCase()
    if (!q) return state.events
    return state.events.filter((evt) => {
      const haystack = [evt.name, evt.scope_church_name, evt.venue_name]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [state, search])

  // Header shared across all views
  const header = signedIn ? (
    <ScreenHeader title='Active Events' back={{ to: '/home', label: 'Home' }} />
  ) : (
    <header className='px-3 sm:px-4 py-3' style={{ borderBottom: '1px solid var(--border)' }}>
      <div className='flex items-center justify-between'>
        <Link
          to='/'
          className='px-2.5 py-1.5 text-xs font-semibold'
          style={{
            background: 'var(--bg2)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-pill)',
            textDecoration: 'none',
            letterSpacing: '0.01em',
          }}
        >
          Sign In
        </Link>
        <button
          onClick={toggleTheme}
          className='p-1.5'
          aria-label='Toggle theme'
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}
        >
          <svg viewBox='0 0 24 24' width='20' height='20' fill='currentColor'>
            {theme === 'dark'
              ? <path d='M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.02 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.02 0-1.41L5.99 4.58zm12.37 12.37c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.02 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0 .39-.39.39-1.02 0-1.41l-1.06-1.06zm1.06-10.96c.39-.39.39-1.02 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.02 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.36c.39-.39.39-1.02 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.02 0 1.41s1.03.39 1.41 0l1.06-1.06z' />
              : <path d='M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z' />
            }
          </svg>
        </button>
      </div>
      <div className='text-center mt-2'>
        <h1 className='text-base font-semibold m-0' style={{ color: 'var(--text)' }}>Active Events</h1>
        <p className='text-xs mt-1 m-0' style={{ color: 'var(--muted)' }}>Scan to check in</p>
      </div>
    </header>
  )

  // ── QR view (single event selected) ──────────────────────────────────────
  if (selected) {
    return (
      <div className='min-h-dvh' style={{ background: 'var(--bg)' }}>
        {header}
        <main className='w-full max-w-lg mx-auto px-3 sm:px-4 py-5 sm:py-6'>
          {/* Back to picker if multiple events */}
          {state.status === 'ok' && state.events.length > 1 && (
            <button
              onClick={() => setSelected(null)}
              className='mb-4 flex items-center gap-1.5 text-sm'
              style={{ color: 'var(--accent)', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontWeight: 600 }}
            >
              ← All events
            </button>
          )}
          <EventQR event={selected} tick={tick} />
        </main>
      </div>
    )
  }

  // ── Picker / loading / error view ─────────────────────────────────────────
  return (
    <div className='min-h-dvh' style={{ background: 'var(--bg)' }}>
      {header}
      <main className='w-full max-w-6xl mx-auto px-3 sm:px-4 lg:px-6 py-5 sm:py-6'>
        {state.status === 'loading' && (
          <Spinner />
        )}

        {state.status === 'error' && (
          <div
            className='p-4 text-sm'
            style={{
              background: 'color-mix(in oklab, var(--absent) 8%, transparent)',
              color: 'var(--coral)',
              border: '1px solid color-mix(in oklab, var(--absent) 25%, transparent)',
              borderRadius: 'var(--radius-btn)',
            }}
          >
            {state.error}
          </div>
        )}

        {state.status === 'ok' && state.events.length === 0 && (
          <div
            className='p-8 text-center'
            style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-card)', boxShadow: 'var(--shadow-2)' }}
          >
            <p className='text-sm m-0' style={{ color: 'var(--muted)' }}>
              No active events right now.
            </p>
          </div>
        )}

        {state.status === 'ok' && state.events.length > 1 && (
          <>
            <p className='eyebrow mb-4'>Select an event</p>
            <div
              className='mb-3 px-3 py-2 flex items-center gap-2'
              style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-btn)' }}
            >
              <svg viewBox='0 0 24 24' width='16' height='16' fill='currentColor' style={{ color: 'var(--muted)', flexShrink: 0 }}>
                <path d='M15.5 14h-.79l-.28-.27a6 6 0 1 0-.71.71l.27.28v.79L20 21.5 21.5 20l-6-6zm-5.5 0a4 4 0 1 1 0-8 4 4 0 0 1 0 8z' />
              </svg>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder='Search events, venue, church...'
                className='w-full text-sm'
                style={{ background: 'transparent', color: 'var(--text)', border: 'none', outline: 'none' }}
                aria-label='Search active events'
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  className='text-xs font-semibold px-2 py-1 cursor-pointer'
                  style={{ background: 'var(--bg2)', color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: 'var(--radius-pill)' }}
                >
                  Clear
                </button>
              )}
            </div>
            {filteredEvents.length === 0 && (
              <p className='text-sm mb-3' style={{ color: 'var(--muted)' }}>No matching events.</p>
            )}
            <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3'>
              {filteredEvents.map((evt) => (
                <button
                  key={evt.id}
                  onClick={() => setSelected(evt)}
                  className='w-full h-full px-4 py-4 text-left'
                  style={{
                    background: 'var(--card)',
                    border: '1.5px solid var(--border)',
                    borderRadius: 'var(--radius-btn)',
                    boxShadow: 'var(--shadow-1)',
                    cursor: 'pointer',
                  }}
                >
                  <p className='text-sm sm:text-base font-semibold m-0' style={{ color: 'var(--text)', letterSpacing: '-0.01em' }}>{evt.name}</p>
                  <p className='text-xs sm:text-sm m-0 mt-1' style={{ color: 'var(--muted)' }}>
                    {evt.scope_church_name} · ends in {formatDistanceToNowStrict(new Date(evt.ends_at))}
                  </p>
                </button>
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  )
}

function EventQR({ event, tick }: { event: CheckinEventRow; tick: number }) {
  const [token, setToken] = useState<string | null>(null)
  const [pin, setPin] = useState<string | null>(null)
  const [secsLeft, setSecsLeft] = useState(() => 15 - (Math.floor(Date.now() / 1000) % 15))
  const [pinTick, setPinTick] = useState(0)
  const [qrSize, setQrSize] = useState(260)
  const showQr  = event.allowed_check_in_methods.includes('QR')
  const showPin = event.allowed_check_in_methods.includes('PIN')

  useEffect(() => {
    const updateSize = () => {
      // Keep QR large on desktop but fit safely on small screens.
      const next = Math.max(180, Math.min(300, window.innerWidth - 64))
      setQrSize(next)
    }
    updateSize()
    window.addEventListener('resize', updateSize)
    return () => window.removeEventListener('resize', updateSize)
  }, [])

  // QR token — regenerates on parent tick (every 30 s covers the 60-second QR bucket).
  // Skip token generation entirely when QR is not an allowed method for this event.
  useEffect(() => {
    if (!showQr) return
    let cancelled = false
    ;(async () => {
      const t = await generateQrToken({ secretHex: event.qr_secret_hex, eventId: event.id, bucket: currentBucket() })
      if (!cancelled) setToken(t)
    })()
    return () => { cancelled = true }
  }, [event.id, event.qr_secret_hex, tick, showQr])

  // PIN — regenerates on its own 15-second cycle
  useEffect(() => {
    if (!showPin) return
    let cancelled = false
    ;(async () => {
      const p = await generateRotatingPin({ secretHex: event.qr_secret_hex, eventId: event.id })
      if (!cancelled) setPin(p)
    })()
    return () => { cancelled = true }
  }, [event.id, event.qr_secret_hex, pinTick, showPin])

  // 1-second ticker: update countdown, fire pinTick at each 15-second boundary
  useEffect(() => {
    const id = setInterval(() => {
      const secs = Math.floor(Date.now() / 1000)
      const sl = 15 - (secs % 15)
      setSecsLeft(sl)
      if (sl === 15) setPinTick((t) => t + 1)
    }, 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div
      className='p-4 sm:p-5 text-center'
      style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-card)', boxShadow: 'var(--shadow-2)' }}
    >
      <p className='eyebrow m-0 mb-2 justify-center'>
        {event.scope_level} · {event.scope_church_name}
      </p>
      <h3 className='text-base font-semibold mb-4 m-0' style={{ color: 'var(--text)', letterSpacing: '-0.02em' }}>{event.name}</h3>
      {showQr ? (
        token ? <QRCodeDisplay value={token} size={qrSize} /> : <Spinner />
      ) : (
        <div
          className='mx-auto p-6 text-center'
          style={{
            background: 'var(--bg2)',
            border: '1px dashed var(--border)',
            borderRadius: 'var(--radius-card)',
            maxWidth: qrSize,
          }}
        >
          <p className='text-sm font-semibold m-0' style={{ color: 'var(--text)' }}>
            QR check-in is not enabled for this event
          </p>
          <p className='text-xs mt-2 m-0' style={{ color: 'var(--muted)' }}>
            {showPin
              ? 'Use the PIN below to check in.'
              : 'Check in through the app instead.'}
          </p>
        </div>
      )}
      {showPin && pin && (
        <div className='mt-5' style={{ borderTop: '1px solid var(--border)', paddingTop: '1.25rem' }}>
          <p className='eyebrow m-0 mb-2 justify-center'>PIN</p>
          <p
            className='text-4xl font-bold m-0'
            style={{ color: 'var(--text)', letterSpacing: '0.25em', fontVariantNumeric: 'tabular-nums' }}
          >
            {pin}
          </p>
        </div>
      )}
      <p className='text-xs mt-4 m-0' style={{ color: 'var(--muted)' }}>
        Ends in {formatDistanceToNowStrict(new Date(event.ends_at))}
        {(showQr || showPin) && <> {' · '}rotates in {secsLeft}s</>}
      </p>
    </div>
  )
}
