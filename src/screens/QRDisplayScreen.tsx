// QR display — public AND in-app.
// Anonymous viewers (device mounted at the venue) see a chromeless display.
// Authenticated viewers (coming from the hamburger menu) get a ScreenHeader
// with the menu and a back link so they don't feel trapped.

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import QRCodeDisplay from '../components/checkin/QRCodeDisplay'
import ScreenHeader from '../components/ScreenHeader'
import { PageShell } from '../components/layout/PageShell'
import { Alert } from '../components/ui/alert'
import { listActiveEvents, listActiveSpecialGroupEventsForUser } from '../utils/supabaseCheckins'
import Spinner from '../components/Spinner'
import { generateQrToken, currentBucket } from '../utils/checkinsCrypto'
import { useRotatingPin } from '../hooks/useRotatingPin'
import { formatDistanceToNowStrict } from 'date-fns'
import type { CheckinEventRow } from '../types/app'
import { getCurrentUser } from '../utils/auth'
import { useTheme } from '../hooks/useTheme'
type QRState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ok'; events: CheckinEventRow[] }

function isSignedIn() {
  return !!localStorage.getItem('accessToken')
}

const REFRESH_INTERVAL_MS = 30_000

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
        let events: CheckinEventRow[]
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
  const { preference, resolved, toggle: toggleTheme } = useTheme()
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

  const header = signedIn ? (
    <ScreenHeader title='Active Events' back={{ to: '/home', label: 'Home' }} />
  ) : (
    <header className='border-b border-border bg-card px-3 py-3 sm:px-4'>
      <div className='flex items-center justify-between'>
        <Link to='/' className='btn-pill btn-secondary px-2.5 py-1.5 text-xs no-underline'>
          Sign In
        </Link>
        <button
          onClick={toggleTheme}
          aria-label={`Theme: ${preference}. Tap to cycle.`}
          className='icon-btn border-0 bg-transparent p-1.5 text-muted-foreground'
        >
          <svg viewBox='0 0 24 24' width='20' height='20' fill='currentColor' aria-hidden>
            {preference === 'system'
              ? <path d='M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L11 15v4c0 .55.45 1 1 1v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z' />
              : resolved === 'dark'
              ? <path d='M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.02 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.02 0-1.41L5.99 4.58zm12.37 12.37c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.02 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0 .39-.39.39-1.02 0-1.41l-1.06-1.06zm1.06-10.96c.39-.39.39-1.02 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.02 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.36c-.39-.39.39-1.02 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.02 0 1.41s1.03.39 1.41 0l1.06-1.06z' />
              : <path d='M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z' />}
          </svg>
        </button>
      </div>
      <div className='mt-2 text-center'>
        <h1 className='m-0 text-base font-semibold text-foreground'>Active Events</h1>
        <p className='m-0 mt-1 text-xs text-muted-foreground'>Scan to check in</p>
      </div>
    </header>
  )

  if (selected) {
    return (
      <PageShell noSidebar={!signedIn}>
        {header}
        <main className='mx-auto w-full max-w-lg px-3 py-5 sm:px-4 sm:py-6'>
          {state.status === 'ok' && state.events.length > 1 && (
            <button
              type='button'
              onClick={() => setSelected(null)}
              className='mb-4 flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-sm font-semibold text-primary'
            >
              ← All events
            </button>
          )}
          <EventQR event={selected} tick={tick} />
        </main>
      </PageShell>
    )
  }

  return (
    <PageShell noSidebar={!signedIn}>
      {header}
      <main className='mx-auto w-full max-w-6xl px-3 py-5 sm:px-4 lg:px-6 sm:py-6'>
        {state.status === 'loading' && <Spinner />}

        {state.status === 'error' && (
          <Alert variant='destructive'>{state.error}</Alert>
        )}

        {state.status === 'ok' && state.events.length === 0 && (
          <div className='surface-card p-8 text-center'>
            <p className='m-0 text-sm text-muted-foreground'>No active events right now.</p>
          </div>
        )}

        {state.status === 'ok' && state.events.length > 1 && (
          <>
            <p className='section-heading mb-4'>Select an event</p>
            <div className='surface-card mb-3 flex items-center gap-2 rounded-lg px-3 py-2'>
              <svg viewBox='0 0 24 24' width='16' height='16' fill='currentColor' className='shrink-0 text-muted-foreground'>
                <path d='M15.5 14h-.79l-.28-.27a6 6 0 1 0-.71.71l.27.28v.79L20 21.5 21.5 20l-6-6zm-5.5 0a4 4 0 1 1 0-8 4 4 0 0 1 0 8z' />
              </svg>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder='Search events, venue, church...'
                className='w-full border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground'
                aria-label='Search active events'
              />
              {search && (
                <button
                  type='button'
                  onClick={() => setSearch('')}
                  className='chip cursor-pointer px-2 py-1 text-xs font-semibold text-muted-foreground'
                >
                  Clear
                </button>
              )}
            </div>
            {filteredEvents.length === 0 && (
              <p className='mb-3 text-sm text-muted-foreground'>No matching events.</p>
            )}
            <div className='grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3'>
              {filteredEvents.map((evt) => (
                <button
                  key={evt.id}
                  type='button'
                  onClick={() => setSelected(evt)}
                  className='surface-card w-full cursor-pointer px-4 py-4 text-left transition-all hover:border-primary/35 active:scale-[0.99]'
                >
                  <p className='m-0 text-sm font-semibold tracking-tight text-foreground sm:text-base'>{evt.name}</p>
                  <p className='m-0 mt-1 text-xs text-muted-foreground sm:text-sm'>
                    {evt.scope_church_name} · ends in {formatDistanceToNowStrict(new Date(evt.ends_at))}
                  </p>
                </button>
              ))}
            </div>
          </>
        )}
      </main>
    </PageShell>
  )
}

function EventQR({ event, tick }: { event: CheckinEventRow; tick: number }) {
  const [token, setToken] = useState<string | null>(null)
  const [qrSize, setQrSize] = useState(260)
  const showQr = event.allowed_check_in_methods.includes('QR')
  const showPin = event.allowed_check_in_methods.includes('PIN')
  const { pin, secsLeft } = useRotatingPin(event, showPin)

  useEffect(() => {
    const updateSize = () => {
      const next = Math.max(180, Math.min(300, window.innerWidth - 64))
      setQrSize(next)
    }
    updateSize()
    window.addEventListener('resize', updateSize)
    return () => window.removeEventListener('resize', updateSize)
  }, [])

  useEffect(() => {
    if (!showQr) return
    let cancelled = false
    ;(async () => {
      const t = await generateQrToken({ secretHex: event.qr_secret_hex, eventId: event.id, bucket: currentBucket() })
      if (!cancelled) setToken(t)
    })()
    return () => { cancelled = true }
  }, [event.id, event.qr_secret_hex, tick, showQr])

  return (
    <div className='surface-card p-4 text-center sm:p-5'>
      <p className='section-heading m-0 mb-2 text-center'>
        {event.scope_church_name} · {event.scope_level}
      </p>
      <h3 className='m-0 mb-4 text-base font-semibold tracking-tight text-foreground'>{event.name}</h3>
      {showQr ? (
        token ? <QRCodeDisplay value={token} size={qrSize} /> : <Spinner />
      ) : (
        <div
          className='mx-auto rounded-xl border border-dashed border-border bg-secondary p-6 text-center'
          style={{ maxWidth: qrSize }}
        >
          <p className='m-0 text-sm font-semibold text-foreground'>
            QR check-in is not enabled for this event
          </p>
          <p className='m-0 mt-2 text-xs text-muted-foreground'>
            {showPin ? 'Use the PIN below to check in.' : 'Check in through the app instead.'}
          </p>
        </div>
      )}
      {showPin && pin && (
        <div className='mt-5 border-t border-border pt-5'>
          <p className='section-heading m-0 mb-2 text-center'>PIN</p>
          <p className='tnum m-0 text-4xl font-bold tracking-[0.25em] text-foreground'>{pin}</p>
        </div>
      )}
      <p className='m-0 mt-4 text-xs text-muted-foreground'>
        Ends in {formatDistanceToNowStrict(new Date(event.ends_at))}
        {(showQr || showPin) && <> · rotates in {secsLeft}s</>}
      </p>
    </div>
  )
}
