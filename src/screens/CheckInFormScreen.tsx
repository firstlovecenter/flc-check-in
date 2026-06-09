import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import ScreenHeader from '../components/ScreenHeader'
import Spinner from '../components/Spinner'
import { Skeleton } from '../components/ui/skeleton'
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
import { vibrateSuccess } from '../utils/haptics'

// Submission failures that are about the DEVICE or ACCOUNT, not the attempt —
// these get the hard error screen (with Logout) instead of an inline retry.
const HARD_FAILURE_REASONS = new Set(['device_already_used'])

export default function CheckInFormScreen() {
  const { eventId } = useParams()
  const user = getCurrentUser()

  // RequireAuth handles the redirect, but guard here to avoid a crash
  // during the brief gap when the token has just expired.
  if (!user) return null

  const [event, setEvent] = useState(null)
  const [existingRecord, setExistingRecord] = useState<any>(undefined) // undefined = not yet loaded
  // Hard errors (event failed to load, device blocked) get a dead-end screen;
  // submit errors stay inline so the user can retry immediately.
  const [hardError, setHardError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // 'Confirming…' state: the instant a QR/PIN is captured we transition to a
  // success-shaped screen that resolves to ✓ (or back to the form on error) —
  // the user never stares at a frozen form while the server round-trip runs.
  const [confirming, setConfirming] = useState(false)
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
        if (!cancelled) setHardError(err.message)
      }
    })()
    return () => { cancelled = true }
  }, [eventId, user.userId])

  const handleHeartbeatCheckedOut = useCallback(async () => {
    const updated = await getMyRecord(eventId, user.userId)
    setExistingRecord(updated)
  }, [eventId, user.userId])


  const submit = useCallback(async (method: 'QR' | 'PIN', payload: { qrToken?: string; pin?: string }, position) => {
    if (submitting) return
    if (!navigator.onLine) {
      setSubmitError("You're offline. Reconnect and try again.")
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    setConfirming(true)  // instant transition to the success-shaped screen
    try {
      const fingerprint = await getDeviceFingerprint()
      const result = await submitCheckIn({
        eventId, member: { id: user.userId, name: formatName(user), role: user.level, unitName: user.unitName },
        method, lat: position.lat, lng: position.lng, fingerprint, event, ...payload,
      })
      if (result.ok) {
        vibrateSuccess()
        setSuccess(result.record)
      } else if (HARD_FAILURE_REASONS.has(result.reason)) {
        setConfirming(false)
        setHardError(reasonText(result))
      } else {
        setConfirming(false)
        setSubmitError(reasonText(result))
      }
    } catch (err: any) {
      setConfirming(false)
      setSubmitError(err?.message || 'Check-in failed. Check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }, [event, eventId, submitting, user.firstName, user.lastName, user.level, user.title, user.unitName, user.userId])

  const handleQR  = useCallback((token, position) => submit('QR',  { qrToken: token }, position), [submit])
  const handlePIN = useCallback((pin, position)   => submit('PIN', { pin },            position), [submit])


  if (hardError) {
    return (
      <CenterCard showLogout>
        <h2 className='text-lg font-semibold mb-1 text-destructive'>Cannot check-in with device</h2>
        <p className='text-sm m-0 text-muted-foreground'>{hardError}</p>
      </CenterCard>
    )
  }
  // Still loading event or existing-record lookup — show the form's shape
  // (header, tabs, scanner square) so the real form paints with no shift.
  if (!event || existingRecord === undefined) {
    return (
      <PageShell>
        <ScreenHeader title='Check in' back={{ to: '/home', label: 'Home' }} />
        <PageMainNarrow className='py-6'>
          <Skeleton className='mb-4 h-4 w-1/2' />
          <Skeleton className='mb-5 h-11 rounded-xl' />
          <Skeleton className='mx-auto aspect-square w-full rounded-2xl' />
        </PageMainNarrow>
      </PageShell>
    )
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

  // ── Confirming: QR/PIN captured, server round-trip in flight ─────────────
  // Success-shaped screen so the eventual ✓ is a state change, not a layout
  // change. Failures fall back to the form with an inline error.
  if (confirming && !success) {
    return (
      <PageShell>
        <ScreenHeader title={event.name} back={{ to: '/home', label: 'Home' }} />
        <PageMainNarrow className='flex flex-col gap-4 py-8'>
          <Card>
            <CardContent className='p-6 text-center'>
              <div className='mb-3 flex justify-center'><Spinner fullPage={false} /></div>
              <h2 className='mb-1 text-xl font-bold tracking-tight text-foreground'>Confirming…</h2>
              <p className='text-sm text-muted-foreground'>{event.name}</p>
              <p className='mt-1 text-xs text-muted-foreground'>Recording your check-in</p>
            </CardContent>
          </Card>
        </PageMainNarrow>
      </PageShell>
    )
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

          {submitError && <Alert variant='destructive' className='text-center'>{submitError}</Alert>}

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
            {submitError && <Alert variant='destructive' className='mb-4 text-center'>{submitError}</Alert>}

            {event.allowed_check_in_methods.filter((m) => m !== 'MANUAL').length > 1 && (
              <div className='tab-bar mb-5'>
                {event.allowed_check_in_methods.filter((m) => m !== 'MANUAL').map((m) => (
                  <button
                    key={m}
                    type='button'
                    onClick={() => { setActiveTab(m); setSubmitError(null) }}
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
