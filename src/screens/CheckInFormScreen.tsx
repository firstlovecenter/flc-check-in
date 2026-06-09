import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import ScreenHeader from '../components/ScreenHeader'
import Spinner from '../components/Spinner'
import { PageShell, PageMainNarrow } from '../components/layout/PageShell'
import { CenterCard as LayoutCenterCard } from '../components/layout/CenterCard'
import { Card, CardContent } from '../components/ui/card'
import { Badge } from '../components/ui/badge'
import { Alert } from '../components/ui/alert'
import { Button } from '../components/ui/button'
import { cn } from '../lib/utils'
import GeofenceGuard from '../components/checkin/GeofenceGuard'
import QRScanner from '../components/checkin/QRScanner'
import PinEntry from '../components/checkin/PinEntry'
import RotatingPinDisplay from '../components/checkin/RotatingPinDisplay'
import LocationHeartbeat from '../components/checkin/LocationHeartbeat'
import LocationPreWarmer from '../components/LocationPreWarmer'
import { getCurrentUser, formatName, logout } from '../utils/auth'
import {
  getEvent, submitCheckIn, getMyRecord,
} from '../utils/supabaseCheckins'
import { getDeviceFingerprint } from '../utils/deviceFingerprint'
import { getCurrentPosition } from '../utils/geo'

export default function CheckInFormScreen() {
  const { eventId } = useParams()
  const user = getCurrentUser()

  // RequireAuth handles the redirect, but guard here to avoid a crash
  // during the brief gap when the token has just expired.
  if (!user) return null

  const [event, setEvent] = useState(null)
  const [existingRecord, setExistingRecord] = useState<any>(undefined) // undefined = not yet loaded
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(null)
  const [activeTab, setActiveTab] = useState(null)
  const [initialPosition, setInitialPosition] = useState<any>(null)

  useEffect(() => {
    let cancelled = false
    setInitialPosition(null)

    void getCurrentPosition({ timeout: 15000 })
      .then((position) => {
        if (!cancelled) setInitialPosition(position)
        return position
      })
      .catch(() => null)

    ;(async () => {
      try {
        const [evt, rec] = await Promise.all([
          getEvent(eventId),
          getMyRecord(eventId, user.userId),
        ])
        if (cancelled) return
        setEvent(evt)
        setExistingRecord(rec)
        // Default tab: first allowed method that's not MANUAL
        const tabs = evt.allowed_check_in_methods.filter((m) => m !== 'MANUAL')
        setActiveTab(tabs[0] || null)
      } catch (err: any) {
        if (!cancelled) setError(err.message)
      }
    })()
    return () => { cancelled = true }
  }, [eventId, user.userId])

  const handleHeartbeatCheckedOut = useCallback(async () => {
    const updated = await getMyRecord(eventId, user.userId)
    setExistingRecord(updated)
  }, [eventId, user.userId])


  const handleQR = useCallback(async (token, position) => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const fingerprint = await getDeviceFingerprint()
      const result = await submitCheckIn({
        eventId, member: { id: user.userId, name: formatName(user), role: user.level, unitName: user.unitName },
        method: 'QR', lat: position.lat, lng: position.lng, fingerprint, qrToken: token, event,
      })
      if (result.ok) setSuccess(result.record)
      else setError(reasonText(result))
    } finally {
      setSubmitting(false)
    }
  }, [event, eventId, submitting, user.firstName, user.lastName, user.level, user.title, user.unitName, user.userId])

  const handlePIN = useCallback(async (pin, position) => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const fingerprint = await getDeviceFingerprint()
      const result = await submitCheckIn({
        eventId, member: { id: user.userId, name: formatName(user), role: user.level, unitName: user.unitName },
        method: 'PIN', lat: position.lat, lng: position.lng, fingerprint, pin, event,
      })
      if (result.ok) setSuccess(result.record)
      else setError(reasonText(result))
    } finally {
      setSubmitting(false)
    }
  }, [event, eventId, submitting, user.firstName, user.lastName, user.level, user.title, user.unitName, user.userId])


  if (error) {
    return (
      <CenterCard showLogout>
        <h2 className='text-lg font-semibold mb-1 text-destructive'>Cannot check-in with device</h2>
        <p className='text-sm m-0 text-muted-foreground'>{error}</p>
      </CenterCard>
    )
  }
  // Still loading event or existing-record lookup
  if (!event || existingRecord === undefined) {
    return <Spinner fullPage />
  }

  // Time window check — client only blocks UI for events more than 1 hour
  // before start. The server is the sole timing enforcer; these checks are
  // display hints only so the user sees a meaningful message instead of
  // a cryptic error when they tap 'Check In'.
  const now = Date.now()
  const startsMs  = new Date(event.starts_at).getTime()
  const endsMs    = new Date(event.ends_at).getTime()
  const EARLY_MS  = 60 * 60 * 1000          // 1 hour — mirrors the server rule
  if (event.status === 'PAUSED') {
    return <CenterCard><h2 className='text-lg font-semibold mb-2 text-warning'>Event paused</h2><p className='text-muted-foreground'>{event.name} is currently paused.</p></CenterCard>
  }
  if (event.status === 'ENDED' || now > endsMs) {
    return <CenterCard><h2 className='text-lg font-semibold mb-2 text-muted-foreground'>Event ended</h2><p className='text-muted-foreground'>{event.name} has ended.</p></CenterCard>
  }
  if (now < startsMs - EARLY_MS) {
    const opensAt = new Date(startsMs - EARLY_MS)
    const timeStr = opensAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    return <CenterCard><h2 className='text-lg font-semibold mb-2 text-muted-foreground'>Not open yet</h2><p className='text-muted-foreground'>Check-in for <strong>{event.name}</strong> opens at <strong>{timeStr}</strong> (1 hour before start).</p></CenterCard>
  }

  // ── Already checked in or checked out ────────────────────────────────────
  // Use `success` (just submitted) or `existingRecord` (returning to the screen)
  const activeRecord = success
    ? { ...success, checked_out_at: null }  // just submitted, not yet checked out
    : existingRecord

  if (activeRecord) {
    const checkedOut = !!activeRecord.checked_out_at

    return (
      <PageShell>
        <ScreenHeader title={event.name} back={{ to: '/home', label: 'Home' }} />
        <PageMainNarrow className='flex flex-col gap-4 py-8'>
          <Card>
            <CardContent className='p-6 text-center'>
              {checkedOut ? (
                <>
                  <div className='mb-3 text-4xl'>👋</div>
                  <h2 className='mb-1 text-xl font-bold tracking-tight text-foreground'>Checked Out</h2>
                  <p className='text-sm text-muted-foreground'>{event.name}</p>
                  <p className='mt-3 text-xs text-muted-foreground'>
                    Checked in {fmt(activeRecord.checked_in_at)} · Checked out {fmt(activeRecord.checked_out_at)}
                  </p>
                </>
              ) : (
                <>
                  <div className='mb-3 text-4xl'>✅</div>
                  <h2 className='mb-1 text-xl font-bold tracking-tight text-success'>You&apos;re checked in</h2>
                  <p className='text-sm text-foreground'>{event.name}</p>
                  <p className='mt-1 text-xs text-muted-foreground'>
                    {event.scope_level} · {event.scope_church_name}
                  </p>
                  <div className='mt-4 flex flex-wrap justify-center gap-3'>
                    <Badge variant='success'>{activeRecord.method || success?.method}</Badge>
                    {(activeRecord.is_late ?? success?.is_late) && <Badge variant='warning'>Marked late</Badge>}
                  </div>
                  <p className='mt-3 text-xs text-muted-foreground'>
                    Checked in at {fmt(activeRecord.checked_in_at)}
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          {error && <Alert variant='destructive' className='text-center'>{error}</Alert>}

          <Link to='/home' className='btn-pill btn-secondary w-full text-center no-underline'>
            Back to Home
          </Link>

          {!checkedOut && (
            <LocationHeartbeat
              eventId={event.id}
              memberId={user.userId}
              onCheckedOut={handleHeartbeatCheckedOut}
            />
          )}
        </PageMainNarrow>
      </PageShell>
    )
  }

  return (
    <GeofenceGuard event={event} initialPosition={initialPosition}>
      {(position) => (
        <PageShell>
          <LocationPreWarmer />
          <ScreenHeader title={event.name} back={{ to: '/home', label: 'Home' }} />
          <PageMainNarrow className='py-6'>
            <p className='section-heading mb-4'>{event.scope_level} · {event.scope_church_name}</p>
            {error && <Alert variant='destructive' className='mb-4 text-center'>{error}</Alert>}

            {event.allowed_check_in_methods.filter((m) => m !== 'MANUAL').length > 1 && (
              <div className='tab-bar mb-5'>
                {event.allowed_check_in_methods.filter((m) => m !== 'MANUAL').map((m) => (
                  <button
                    key={m}
                    type='button'
                    onClick={() => { setActiveTab(m); setError(null) }}
                    className={cn('tab-item', activeTab === m && 'tab-item--active')}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}

            {activeTab === 'QR' && (
              <div className='flex flex-col gap-3'>
                <p className='text-sm text-center text-muted-foreground'>
                  Point your camera at the QR code displayed at the venue.
                </p>
                <QRScanner onDecode={(t) => handleQR(t, position)} onError={() => {}} />
                {submitting && <p className='text-xs text-center text-muted-foreground'>Submitting…</p>}
              </div>
            )}

            {activeTab === 'PIN' && (
              <div className='flex flex-col gap-4'>
                <RotatingPinDisplay event={event} />
                <PinEntry
                  disabled={submitting}
                  hint='Enter the PIN shown above.'
                  onSubmit={(pin) => handlePIN(pin, position)}
                />
              </div>
            )}

          </PageMainNarrow>
        </PageShell>
      )}
    </GeofenceGuard>
  )
}

function fmt(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function reasonText(result) {
  switch (result.reason) {
    case 'outside_fence':        return 'You are outside the venue area.'
    case 'invalid_qr_token':     return 'QR code is invalid. Try again.'
    case 'qr_expired':           return 'QR code has expired. Wait for the next rotation.'
    case 'missing_qr_token':     return 'No QR code detected.'
    case 'missing_pin':          return 'Enter the 6-digit PIN.'
    case 'wrong_pin':            return `Wrong PIN. ${result.attempts_left ?? 0} attempts left.`
    case 'locked_out':           return `Too many wrong attempts. Try again after ${new Date(result.lockout_until).toLocaleTimeString()}.`
    case 'pin_not_set':          return 'No PIN configured for this event.'
    case 'event_paused':         return 'This event is currently paused.'
    case 'event_ended':          return 'This event has ended.'
    case 'not_started':          return result.opens_at
                                   ? `Check-in opens at ${new Date(result.opens_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
                                   : "Check-in hasn't opened yet."
    case 'role_not_allowed':      return 'Your role is not included in this event.'
    case 'method_not_allowed':   return 'This check-in method is not enabled for this event.'
    case 'event_not_active':     return `Event is ${result.status?.toLowerCase() || 'not active'}.`
    case 'event_not_found':      return 'Event not found.'
    case 'device_already_used':
      return result.claimed_by_name
        ? `Device already used by ${result.claimed_by_name}.`
        : 'This device has already been used by another leader for this event.'
    case 'already_checked_in':   return 'You are already checked in.'
    case 'unsupported_method':   return 'This check-in method is not supported.'
    case 'server_error':         return result.detail || 'Server error. Try again.'
    case 'rpc_error':
    case 'db_error':             return result.error || 'Server error. Try again.'
    default:                     return result.reason || 'Check-in failed.'
  }
}

/**
 * Centred status card. By default renders a "Back to Home" link so users
 * never land in a dead-end state (e.g. paused event, expired QR/PIN).
 *
 * Pass `showLogout` for hard failures where Home isn't the right exit —
 * e.g. "device blocked by another user" needs the current user to sign out
 * so a different account (or a freshly cleared device) can check in.
 */
function CenterCard({
  children,
  showLogout = false,
}: {
  children: React.ReactNode
  showLogout?: boolean
}) {
  function handleLogout() {
    logout()
    window.location.assign('/')
  }
  return (
    <LayoutCenterCard>
      <div className='flex flex-col gap-4'>
        {children}
        {showLogout ? (
          <Button type='button' variant='outline' className='w-full border-destructive text-destructive' onClick={handleLogout}>
            Logout
          </Button>
        ) : (
          <Link to='/home' className='btn-pill btn-secondary w-full text-center no-underline'>
            Back to Home
          </Link>
        )}
      </div>
    </LayoutCenterCard>
  )
}
