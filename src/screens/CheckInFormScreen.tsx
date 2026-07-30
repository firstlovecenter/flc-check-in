import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
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
import LocationPreWarmer from '../components/LocationPreWarmer'
import { getCurrentUser, formatName, logout } from '../utils/auth'
import { openCheckIn, submitCheckIn } from '../utils/supabaseCheckins'
import { candidateMemberIds } from '../utils/eventEntryGate'
import { getDeviceFingerprint } from '../utils/deviceFingerprint'
import { getCurrentPosition } from '../utils/geo'
import { vibrateSuccess } from '../utils/haptics'
import { friendlyErrorMessage } from '../utils/network'
import i18n from '../lib/i18n'

// Submission failures that are about the DEVICE or ACCOUNT, not the attempt —
// these get the hard error screen (with Logout) instead of an inline retry.
const HARD_FAILURE_REASONS = new Set(['device_already_used'])

export default function CheckInFormScreen() {
  const { t } = useTranslation()
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
        // ONE round trip for event + eligibility + any existing record. This
        // used to be three sequential calls; at a venue that meant three full
        // latency hops before the scanner rendered, and three connections per
        // attendee against a shared PostgREST pool.
        const { found, event: evt, record } = await openCheckIn({
          eventId,
          memberIds: candidateMemberIds(user),
          email: user.email,
        })
        if (cancelled) return
        if (!found) {
          setHardError(t('checkin.eventNotFound'))
          return
        }
        setEvent(evt)
        setExistingRecord(record)
        // Default tab: first allowed method that's not MANUAL
        const tabs = evt.allowed_check_in_methods.filter((m) => m !== 'MANUAL')
        setActiveTab(tabs[0] || null)
      } catch (err: any) {
        if (!cancelled) setHardError(friendlyErrorMessage(err))
      }
    })()
    return () => { cancelled = true }
  }, [eventId, user.userId, user.email])

  const submit = useCallback(async (method: 'QR' | 'PIN', payload: { qrToken?: string; pin?: string }, position) => {
    if (submitting) return
    if (!navigator.onLine) {
      setSubmitError(t('checkin.offlineSubmit'))
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
      setSubmitError(friendlyErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }, [event, eventId, submitting, user.firstName, user.lastName, user.level, user.title, user.unitName, user.userId])

  const handleQR  = useCallback((token, position) => submit('QR',  { qrToken: token }, position), [submit])
  const handlePIN = useCallback((pin, position)   => submit('PIN', { pin },            position), [submit])


  if (hardError) {
    return (
      <CenterCard showLogout>
        <h2 className='text-lg font-semibold mb-1 text-destructive'>{t('checkin.cannotCheckInDevice')}</h2>
        <p className='text-sm m-0 text-muted-foreground'>{hardError}</p>
      </CenterCard>
    )
  }
  // Still loading event or existing-record lookup — show the form's shape
  // (header, tabs, scanner square) so the real form paints with no shift.
  if (!event || existingRecord === undefined) {
    return (
      <PageShell>
        <ScreenHeader title={t('checkin.title')} back={{ to: '/home', label: t('nav.home') }} />
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
    return <CenterCard><h2 className='text-lg font-semibold mb-2 text-warning'>{t('checkin.eventPaused')}</h2><p className='text-muted-foreground'>{t('checkin.eventPausedBody', { name: event.name })}</p></CenterCard>
  }
  if (event.status === 'ENDED' || now > endsMs) {
    return <CenterCard><h2 className='text-lg font-semibold mb-2 text-muted-foreground'>{t('checkin.eventEnded')}</h2><p className='text-muted-foreground'>{t('checkin.eventEndedBody', { name: event.name })}</p></CenterCard>
  }
  if (now < startsMs - EARLY_MS) {
    const opensAt = new Date(startsMs - EARLY_MS)
    const timeStr = opensAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    return <CenterCard><h2 className='text-lg font-semibold mb-2 text-muted-foreground'>{t('checkin.notOpenYet')}</h2><p className='text-muted-foreground'>{t('checkin.notOpenYetBody', { name: event.name, time: timeStr })}</p></CenterCard>
  }

  // ── Confirming: QR/PIN captured, server round-trip in flight ─────────────
  // Success-shaped screen so the eventual ✓ is a state change, not a layout
  // change. Failures fall back to the form with an inline error.
  if (confirming && !success) {
    return (
      <PageShell>
        <ScreenHeader title={event.name} back={{ to: '/home', label: t('nav.home') }} />
        <PageMainNarrow className='flex flex-col gap-4 py-8'>
          <Card>
            <CardContent className='p-6 text-center'>
              <div className='mb-3 flex justify-center'><Spinner fullPage={false} /></div>
              <h2 className='mb-1 text-xl font-bold tracking-tight text-foreground'>{t('checkin.confirming')}</h2>
              <p className='text-sm text-muted-foreground'>{event.name}</p>
              <p className='mt-1 text-xs text-muted-foreground'>{t('checkin.recordingCheckIn')}</p>
            </CardContent>
          </Card>
        </PageMainNarrow>
      </PageShell>
    )
  }

  // ── Already checked in ────────────────────────────────────────────────────
  // Use `success` (just submitted) or `existingRecord` (returning to the screen)
  const activeRecord = success || existingRecord

  if (activeRecord) {
    return (
      <PageShell>
        <ScreenHeader title={event.name} back={{ to: '/home', label: t('nav.home') }} />
        <PageMainNarrow className='flex flex-col gap-4 py-8'>
          <Card>
            <CardContent className='p-6 text-center'>
              <div className='mb-3 text-4xl'>✅</div>
              <h2 className='mb-1 text-xl font-bold tracking-tight text-success'>{t('checkin.checkedIn')}</h2>
              <p className='text-sm text-foreground'>{event.name}</p>
              <p className='mt-1 text-xs text-muted-foreground'>
                {event.scope_level} · {event.scope_church_name}
              </p>
              <div className='mt-4 flex flex-wrap justify-center gap-3'>
                <Badge variant='success'>{activeRecord.method || success?.method}</Badge>
              </div>
              <p className='mt-3 text-sm font-semibold text-foreground'>
                {/* submit_checkin's response omits checked_in_at — a fresh
                    submit just happened, so "now" is the accurate time. */}
                {t('checkin.checkedInAt', { time: fmt(activeRecord.checked_in_at ?? new Date().toISOString()) })}
              </p>
            </CardContent>
          </Card>

          {submitError && <Alert variant='destructive' className='text-center'>{submitError}</Alert>}

          <Link to='/home' className='btn-pill btn-secondary w-full text-center no-underline'>
            {t('checkin.backHome')}
          </Link>
        </PageMainNarrow>
      </PageShell>
    )
  }

  return (
    <GeofenceGuard event={event} initialPosition={initialPosition}>
      {(position) => (
        <PageShell>
          <LocationPreWarmer />
          <ScreenHeader title={event.name} back={{ to: '/home', label: t('nav.home') }} />
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
                  {t('checkin.qrHint')}
                </p>
                <QRScanner onDecode={(token) => handleQR(token, position)} onError={() => {}} />
                {submitting && <p className='text-xs text-center text-muted-foreground'>{t('checkin.submitting')}</p>}
              </div>
            )}

            {activeTab === 'PIN' && (
              <div className='flex flex-col gap-4'>
                <RotatingPinDisplay event={event} />
                <PinEntry
                  disabled={submitting}
                  hint={t('checkin.pinHint')}
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
    case 'outside_fence':        return i18n.t('checkin.reasons.outsideFence')
    case 'invalid_qr_token':     return i18n.t('checkin.reasons.invalidQrToken')
    case 'qr_expired':           return i18n.t('checkin.reasons.qrExpired')
    case 'missing_qr_token':     return i18n.t('checkin.reasons.missingQrToken')
    case 'missing_pin':          return i18n.t('checkin.reasons.missingPin')
    case 'wrong_pin':            return i18n.t('checkin.reasons.wrongPin', { count: result.attempts_left ?? 0 })
    case 'locked_out':           return i18n.t('checkin.reasons.lockedOut', { time: new Date(result.lockout_until).toLocaleTimeString() })
    case 'pin_not_set':          return i18n.t('checkin.reasons.pinNotSet')
    case 'event_paused':         return i18n.t('checkin.reasons.eventPaused')
    case 'event_ended':          return i18n.t('checkin.reasons.eventEnded')
    case 'not_started':          return result.opens_at
                                   ? i18n.t('checkin.reasons.notStartedAt', { time: new Date(result.opens_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
                                   : i18n.t('checkin.reasons.notStarted')
    case 'role_not_allowed':
    case 'not_eligible':         return i18n.t('checkin.reasons.notEligible')
    case 'method_not_allowed':   return i18n.t('checkin.reasons.methodNotAllowed')
    case 'event_not_active':     return i18n.t('checkin.reasons.eventNotActive', { status: result.status?.toLowerCase() || 'not active' })
    case 'event_not_found':      return i18n.t('checkin.eventNotFound')
    case 'device_already_used':
      return result.claimed_by_name
        ? i18n.t('checkin.reasons.deviceUsedBy', { name: result.claimed_by_name })
        : i18n.t('checkin.reasons.deviceAlreadyUsed')
    case 'already_checked_in':   return i18n.t('checkin.reasons.alreadyCheckedIn')
    case 'unsupported_method':   return i18n.t('checkin.reasons.unsupportedMethod')
    case 'server_error':         return result.detail || i18n.t('checkin.reasons.serverError')
    case 'rpc_error':
    case 'db_error':             return result.error || i18n.t('checkin.reasons.serverError')
    default:                     return result.reason || i18n.t('checkin.reasons.failed')
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
  const { t } = useTranslation()
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
            {t('nav.logOut')}
          </Button>
        ) : (
          <Link to='/home' className='btn-pill btn-secondary w-full text-center no-underline'>
            {t('checkin.backHome')}
          </Link>
        )}
      </div>
    </LayoutCenterCard>
  )
}
