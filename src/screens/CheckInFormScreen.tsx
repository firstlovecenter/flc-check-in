import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import ScreenHeader from '../components/ScreenHeader'
import GeofenceGuard from '../components/checkin/GeofenceGuard'
import QRScanner from '../components/checkin/QRScanner'
import PinEntry from '../components/checkin/PinEntry'
import FaceCapture from '../components/checkin/FaceCapture'
import LocationHeartbeat from '../components/checkin/LocationHeartbeat'
import { getCurrentUser } from '../utils/auth'
import {
  getEvent, submitCheckIn, getMyRecord, selfCheckOut,
  getMyFaceDescriptor, claimFaceMatch,
} from '../utils/supabaseCheckins'
import { getDeviceFingerprint } from '../utils/deviceFingerprint'
import { getCurrentPosition } from '../utils/geo'

export default function CheckInFormScreen() {
  const { eventId } = useParams()
  const user = getCurrentUser()

  const [event, setEvent] = useState(null)
  const [existingRecord, setExistingRecord] = useState<any>(undefined) // undefined = not yet loaded
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(null)
  const [activeTab, setActiveTab] = useState(null)
  const [initialPosition, setInitialPosition] = useState<any>(null)
  // Face ID — null = not yet loaded, false = no descriptor enrolled, Float32Array = enrolled.
  // Self-service enrol / re-enrol / reset is intentionally not available here.
  // First-time enrolment runs from BiometricEnrolGate on login; admins are the
  // only path to clear or re-enrol an existing descriptor.
  const [faceDescriptor, setFaceDescriptor] = useState<Float32Array | false | null>(null)

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
        eventId, member: { id: user.userId, name: `${user.firstName} ${user.lastName}`.trim(), role: user.level, unitName: user.unitName },
        method: 'QR', lat: position.lat, lng: position.lng, fingerprint, qrToken: token, event,
      })
      if (result.ok) setSuccess(result.record)
      else setError(reasonText(result))
    } finally {
      setSubmitting(false)
    }
  }, [event, eventId, submitting, user.firstName, user.lastName, user.level, user.unitName, user.userId])

  const handlePIN = useCallback(async (pin, position) => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const fingerprint = await getDeviceFingerprint()
      const result = await submitCheckIn({
        eventId, member: { id: user.userId, name: `${user.firstName} ${user.lastName}`.trim(), role: user.level, unitName: user.unitName },
        method: 'PIN', lat: position.lat, lng: position.lng, fingerprint, pin, event,
      })
      if (result.ok) setSuccess(result.record)
      else setError(reasonText(result))
    } finally {
      setSubmitting(false)
    }
  }, [event, eventId, submitting, user.firstName, user.lastName, user.level, user.unitName, user.userId])

  // Lazy-load the stored face descriptor the first time the user opens the
  // FACE_ID tab. `false` means "checked, none on file → enrollment needed".
  useEffect(() => {
    if (activeTab !== 'FACE_ID') return
    if (faceDescriptor !== null) return  // already loaded (Float32Array or false)
    ;(async () => {
      try {
        const d = await getMyFaceDescriptor(user.userId)
        setFaceDescriptor(d ?? false)
      } catch {
        setFaceDescriptor(false)
      }
    })()
  }, [activeTab, faceDescriptor, user.userId])

  const handleFaceVerified = useCallback(async (_descriptor: Float32Array, position) => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const claim = await claimFaceMatch(eventId, user.userId)
      if (!claim?.ok) {
        setError(reasonText(claim || { reason: 'rpc_error' }))
        return
      }
      const fingerprint = await getDeviceFingerprint()
      const result = await submitCheckIn({
        eventId, member: { id: user.userId, name: `${user.firstName} ${user.lastName}`.trim(), role: user.level, unitName: user.unitName },
        method: 'FACE_ID', lat: position.lat, lng: position.lng, fingerprint, event,
      })
      if (result.ok) setSuccess(result.record)
      else setError(reasonText(result))
    } finally {
      setSubmitting(false)
    }
  }, [event, eventId, submitting, user.firstName, user.lastName, user.level, user.unitName, user.userId])

  if (error) {
    return <CenterCard><p style={{ color: 'var(--coral)' }}>{error}</p></CenterCard>
  }
  // Still loading event or existing-record lookup
  if (!event || existingRecord === undefined) {
    return <CenterCard><p style={{ color: 'var(--muted)' }}>Loading event…</p></CenterCard>
  }

  // Time window check (event status + start/end)
  const now = Date.now()
  const startsMs = new Date(event.starts_at).getTime()
  const endsMs = new Date(event.ends_at).getTime()
  if (event.status === 'PAUSED') {
    return <CenterCard><h2 className='text-lg font-semibold mb-2' style={{ color: 'var(--amber)' }}>Event paused</h2><p style={{ color: 'var(--muted)' }}>{event.name} is currently paused.</p></CenterCard>
  }
  if (event.status === 'ENDED' || now > endsMs) {
    return <CenterCard><h2 className='text-lg font-semibold mb-2' style={{ color: 'var(--muted)' }}>Event ended</h2><p style={{ color: 'var(--muted)' }}>{event.name} has ended.</p></CenterCard>
  }
  if (now < startsMs) {
    return <CenterCard><h2 className='text-lg font-semibold mb-2' style={{ color: 'var(--muted)' }}>Not started yet</h2><p style={{ color: 'var(--muted)' }}>{event.name} hasn't started.</p></CenterCard>
  }

  // ── Already checked in or checked out ────────────────────────────────────
  // Use `success` (just submitted) or `existingRecord` (returning to the screen)
  const activeRecord = success
    ? { ...success, checked_out_at: null }  // just submitted, not yet checked out
    : existingRecord

  if (activeRecord) {
    const checkedOut = !!activeRecord.checked_out_at

    async function handleCheckOut() {
      if (submitting) return
      setSubmitting(true)
      setError(null)
      try {
        await selfCheckOut(activeRecord.id)
        // Refresh record so UI updates
        const updated = await getMyRecord(eventId, user.userId)
        setExistingRecord(updated)
        if (success) setSuccess(null) // clear just-submitted state
      } catch (err: any) {
        setError(err.message)
      } finally {
        setSubmitting(false)
      }
    }

    return (
      <div className='min-h-dvh' style={{ background: 'var(--bg)' }}>
        <ScreenHeader title={event.name} back={{ to: '/home', label: 'Home' }} />
        <main className='max-w-md mx-auto px-4 py-8 flex flex-col gap-4'>

          {/* Summary card */}
          <div
            className='p-6 text-center'
            style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-card)', boxShadow: 'var(--shadow-2)' }}
          >
            {checkedOut ? (
              <>
                <div className='text-4xl mb-3'>👋</div>
                <h2 className='text-xl font-bold mb-1' style={{ color: 'var(--text)', letterSpacing: '-0.02em' }}>Checked Out</h2>
                <p className='text-sm' style={{ color: 'var(--muted)' }}>{event.name}</p>
                <p className='text-xs mt-3' style={{ color: 'var(--muted)' }}>
                  Checked in {fmt(activeRecord.checked_in_at)} · Checked out {fmt(activeRecord.checked_out_at)}
                </p>
              </>
            ) : (
              <>
                <div className='text-4xl mb-3'>✅</div>
                <h2 className='text-xl font-bold mb-1' style={{ color: 'var(--green)', letterSpacing: '-0.02em' }}>You're checked in</h2>
                <p className='text-sm' style={{ color: 'var(--text)' }}>{event.name}</p>
                <p className='text-xs mt-1' style={{ color: 'var(--muted)' }}>
                  {event.scope_level} · {event.scope_church_name}
                </p>
                <div className='mt-4 flex justify-center gap-3 flex-wrap'>
                  <span
                    className='px-3 py-1 text-xs font-semibold'
                    style={{ background: 'rgba(52,211,153,0.12)', color: 'var(--green)', border: '1px solid rgba(52,211,153,0.3)', borderRadius: 'var(--radius-pill)' }}
                  >
                    {activeRecord.method || success?.method}
                  </span>
                  {(activeRecord.is_late ?? success?.is_late) && (
                    <span
                      className='px-3 py-1 text-xs font-semibold'
                      style={{ background: 'rgba(251,191,36,0.12)', color: 'var(--amber)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 'var(--radius-pill)' }}
                    >
                      Marked late
                    </span>
                  )}
                </div>
                <p className='text-xs mt-3' style={{ color: 'var(--muted)' }}>
                  Checked in at {fmt(activeRecord.checked_in_at)}
                </p>
              </>
            )}
          </div>

          {/* Error */}
          {error && (
            <p className='text-sm text-center' style={{ color: 'var(--coral)' }}>{error}</p>
          )}

          {/* Actions */}
          <div className='flex flex-col gap-3'>
            {!checkedOut && (
              <button
                onClick={handleCheckOut}
                disabled={submitting}
                className='w-full py-3 text-sm font-semibold cursor-pointer btn-pill'
                style={{
                  background: 'transparent',
                  color: 'var(--coral)',
                  border: '1.5px solid var(--coral)',
                  opacity: submitting ? 0.5 : 1,
                }}
              >
                {submitting ? 'Checking out…' : 'Check Out'}
              </button>
            )}
            <Link to='/home' className='btn-pill btn-secondary w-full text-center' style={{ fontSize: '14px' }}>
              Back to Home
            </Link>
          </div>

          {/* Location heartbeat for auto-checkout while screen is open */}
          {!checkedOut && (
            <LocationHeartbeat
              eventId={event.id}
              memberId={user.userId}
              onCheckedOut={handleHeartbeatCheckedOut}
            />
          )}
        </main>
      </div>
    )
  }

  return (
    <GeofenceGuard event={event} initialPosition={initialPosition}>
      {(position) => (
        <div className='min-h-dvh' style={{ background: 'var(--bg)' }}>
          <ScreenHeader title={event.name} back={{ to: '/home', label: 'Home' }} />
          <main className='max-w-md mx-auto px-4 py-6'>
            <p className='eyebrow mb-4'>{event.scope_level} · {event.scope_church_name}</p>
            {error && (
              <div
                className='p-3 mb-4 text-sm text-center'
                style={{
                  background: 'rgba(232,96,74,0.08)',
                  color: 'var(--coral)',
                  border: '1px solid rgba(232,96,74,0.25)',
                  borderRadius: 'var(--radius-btn)',
                }}
              >
                {error}
              </div>
            )}

            {/* Method tabs — pill toggle */}
            {event.allowed_check_in_methods.filter((m) => m !== 'MANUAL').length > 1 && (
              <div
                className='flex gap-1 mb-5 p-1'
                style={{ background: 'var(--bg2)', borderRadius: 'var(--radius-pill)', border: '1px solid var(--border)' }}
              >
                {event.allowed_check_in_methods.filter((m) => m !== 'MANUAL').map((m) => (
                  <button
                    key={m}
                    onClick={() => { setActiveTab(m); setError(null) }}
                    className='flex-1 py-2 text-xs font-semibold cursor-pointer transition-colors'
                    style={{
                      background: activeTab === m ? 'var(--cta-bg)' : 'transparent',
                      color: activeTab === m ? 'var(--cta-text)' : 'var(--muted)',
                      border: 'none',
                      borderRadius: 'var(--radius-pill)',
                      letterSpacing: '0.04em',
                    }}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}

            {activeTab === 'QR' && (
              <div className='flex flex-col gap-3'>
                <p className='text-sm text-center' style={{ color: 'var(--muted)' }}>
                  Point your camera at the QR code displayed at the venue.
                </p>
                <QRScanner onDecode={(t) => handleQR(t, position)} onError={() => {}} />
                {submitting && <p className='text-xs text-center' style={{ color: 'var(--muted)' }}>Submitting…</p>}
              </div>
            )}

            {activeTab === 'PIN' && (
              <PinEntry
                disabled={submitting}
                hint='Enter the PIN displayed at the venue.'
                onSubmit={(pin) => handlePIN(pin, position)}
              />
            )}

            {activeTab === 'FACE_ID' && (
              <div className='flex flex-col gap-3'>
                {faceDescriptor === null && (
                  <p className='text-sm text-center' style={{ color: 'var(--muted)' }}>Loading face profile…</p>
                )}

                {faceDescriptor === false && (
                  <div
                    className='p-4 flex flex-col gap-2'
                    style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-card)' }}
                  >
                    <p className='text-sm m-0 text-center' style={{ color: 'var(--text)' }}>
                      Face ID is not set up for your account.
                    </p>
                    <p className='text-xs m-0 text-center' style={{ color: 'var(--muted)' }}>
                      Please contact an admin to enable Face ID, or use QR / PIN to check in.
                    </p>
                  </div>
                )}

                {faceDescriptor instanceof Float32Array && (
                  <>
                    <p className='text-sm text-center' style={{ color: 'var(--muted)' }}>
                      Look at the camera, then blink to confirm.
                    </p>
                    <FaceCapture
                      mode='verify'
                      targetDescriptor={faceDescriptor}
                      onComplete={(d) => handleFaceVerified(d, position)}
                      onError={(err) => setError(err.message)}
                    />
                    {submitting && <p className='text-xs text-center' style={{ color: 'var(--muted)' }}>Submitting…</p>}
                  </>
                )}
              </div>
            )}
          </main>
        </div>
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
    case 'not_started':          return "This event hasn't started yet."
    case 'method_not_allowed':   return 'This check-in method is not enabled for this event.'
    case 'event_not_active':     return `Event is ${result.status?.toLowerCase() || 'not active'}.`
    case 'event_not_found':      return 'Event not found.'
    case 'device_already_used':  return 'This device has already been used by another leader for this event.'
    case 'already_checked_in':   return 'You are already checked in.'
    case 'unsupported_method':   return 'This check-in method is not supported.'
    case 'face_match_required':  return 'Face check did not complete. Try again.'
    case 'face_match_expired':   return 'Face check timed out. Try again.'
    case 'server_error':         return result.detail || 'Server error. Try again.'
    case 'rpc_error':
    case 'db_error':             return result.error || 'Server error. Try again.'
    default:                     return result.reason || 'Check-in failed.'
  }
}

function CenterCard({ children }) {
  return (
    <div className='min-h-dvh flex items-center justify-center px-4' style={{ background: 'var(--bg)' }}>
      <div
        className='w-full max-w-md p-6 text-center'
        style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-card)', boxShadow: 'var(--shadow-2)' }}
      >
        {children}
      </div>
    </div>
  )
}
