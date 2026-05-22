import type { ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Spinner from '../Spinner'
import GeoFencePicker from './GeoFencePicker'
import CheckInAdminControls from './CheckInAdminControls'
import { getEvent, updateEvent, resetPin } from '../../utils/supabaseCheckins'
import { allowedRolesForScope } from '../../utils/membersApi'
import { generatePin } from '../../utils/checkinsCrypto'
import type { CheckinEventRow, GeofenceInput } from '../../types/app'

const ALL_METHODS = ['QR', 'PIN', 'FACE_ID', 'MANUAL']

// Fields that we refuse to change while the event is ACTIVE — they would
// silently affect ongoing check-ins. Edit them only when PAUSED or ENDED.
const DANGEROUS_FIELDS_ON_ACTIVE = new Set([
  'allowed_roles',
  'allowed_check_in_methods',
  'geofence',
])

type Patch = Partial<CheckinEventRow> & Record<string, any>

export default function EventEditForm({ eventId }: { eventId: string }) {
  const navigate = useNavigate()
  const [event, setEvent] = useState<CheckinEventRow | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  // Editable state
  const [name, setName]                       = useState('')
  const [venueName, setVenueName]             = useState('')
  const [startsAt, setStartsAt]               = useState('')
  const [endsAt, setEndsAt]                   = useState('')
  const [gracePeriodMin, setGracePeriodMin]   = useState<number | string>(15)
  const [autoCheckoutMin, setAutoCheckoutMin] = useState<number | string>(0)
  const [methods, setMethods]                 = useState<string[]>([])
  const [roles, setRoles]                     = useState<string[]>([])
  const [geofence, setGeofence]               = useState<GeofenceInput | null>(null)
  const [pin, setPin]                         = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const evt = await getEvent(eventId)
        if (cancelled) return
        setEvent(evt)
        setName(evt.name)
        setVenueName(evt.venue_name || '')
        setStartsAt(toLocalInput(evt.starts_at))
        setEndsAt(toLocalInput(evt.ends_at))
        setGracePeriodMin(evt.grace_period_min ?? 15)
        setAutoCheckoutMin(evt.auto_checkout_min ?? 0)
        setMethods(evt.allowed_check_in_methods || [])
        setRoles(evt.allowed_roles || [])
        setPin('') // PIN never returns from server; admin types a new one if rotating
        setGeofence(
          evt.geofence_type === 'circle'
            ? { type: 'circle', centerLat: evt.geofence_center_lat, centerLng: evt.geofence_center_lng, radiusM: evt.geofence_radius_m }
            : { type: 'polygon', polygon: evt.geofence_polygon || [] }
        )
      } catch (err: any) {
        if (!cancelled) setError(err.message)
      }
    })()
    return () => { cancelled = true }
  }, [eventId])

  const isActive = event?.status === 'ACTIVE'
  const isEnded  = event?.status === 'ENDED'
  const locked = (field) => isActive && DANGEROUS_FIELDS_ON_ACTIVE.has(field)
  const availableRoles = useMemo(
    () => (event ? allowedRolesForScope(event.scope_level) : []),
    [event]
  )

  function toggleArr(setter, current, value) {
    setter(current.includes(value) ? current.filter((v) => v !== value) : [...current, value])
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setSaved(false)
    if (!event) return
    if (methods.length === 0) { setError('Pick at least one check-in method.'); return }
    if (roles.length === 0)   { setError('Pick at least one allowed role.'); return }
    if (geofence?.type === 'polygon') {
      if ((geofence.polygon || []).length < 3) {
        setError('Polygon needs at least 3 vertices.'); return
      }
    }

    const patch: Patch = {
      name,
      venue_name: venueName.trim() || null,
      starts_at: new Date(startsAt) as any,
      ends_at: new Date(endsAt) as any,
      grace_period_min: Number(gracePeriodMin),
      auto_checkout_min: Number(autoCheckoutMin),
    }
    if (!locked('allowed_check_in_methods')) patch.allowed_check_in_methods = methods as any
    if (!locked('allowed_roles'))           patch.allowed_roles = roles
    if (!locked('geofence') && geofence) {
      patch.geofence_type = geofence.type
      if (geofence.type === 'circle') {
        patch.geofence_center_lat = geofence.centerLat
        patch.geofence_center_lng = geofence.centerLng
        patch.geofence_radius_m   = geofence.radiusM
        patch.geofence_polygon    = null
      } else {
        patch.geofence_polygon    = geofence.polygon
        patch.geofence_center_lat = null
        patch.geofence_center_lng = null
        patch.geofence_radius_m   = null
      }
    }

    setSaving(true)
    try {
      const updated = await updateEvent(eventId, patch)
      setEvent(updated)
      // Optional PIN rotate if the admin filled it in
      if (pin && pin.length === 6) {
        await resetPin(eventId, pin)
        setPin('')
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (err: any) {
      setError(err.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleResetPin() {
    const newPin = generatePin()
    try {
      await resetPin(eventId, newPin)
      alert(`New PIN: ${newPin}`)
    } catch (err: any) {
      alert(err.message || 'Reset failed')
    }
  }

  if (error && !event) return <Centered><p style={{ color: 'var(--coral)' }}>{error}</p></Centered>
  if (!event) return <Spinner fullPage />

  return (
    <form onSubmit={handleSubmit} className='flex flex-col gap-5'>
      {/* Lifecycle controls — always at the top */}
      <Section title='Status & controls'>
        <p className='text-xs' style={{ color: 'var(--muted)' }}>
          Current status: <span className='uppercase tracking-wider' style={{ color: 'var(--accent)' }}>{event.status}</span>
        </p>
        <CheckInAdminControls event={event} onChange={(updated) => {
          setEvent(updated)
          if (updated.ends_at) setEndsAt(toLocalInput(updated.ends_at))
        }} />
      </Section>

      <Section title='Event'>
        <Field label='Name'>
          <input type='text' required value={name} onChange={(e) => setName(e.target.value)}
            className={inputClasses()} style={inputStyle} />
        </Field>
        <Field label='Venue / Location name'>
          <input type='text' value={venueName} onChange={(e) => setVenueName(e.target.value)}
            placeholder='e.g. First Love Center, The Qodesh'
            className={inputClasses()} style={inputStyle} />
        </Field>
        <Field label='Scope (read-only)'>
          <p className='m-0 px-4 py-2.5 text-sm' style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-btn)', color: 'var(--text)' }}>
            <span className='uppercase tracking-wider' style={{ color: 'var(--accent)' }}>{event.scope_level}</span>
            <span style={{ color: 'var(--border)' }}> · </span>
            {event.scope_church_name}
          </p>
        </Field>
      </Section>

      <Section title='Time window'>
        <div className='grid grid-cols-2 gap-3'>
          <Field label='Starts'>
            <input type='datetime-local' required value={startsAt} onChange={(e) => setStartsAt(e.target.value)}
              className={inputClasses()} style={inputStyle} />
          </Field>
          <Field label='Ends'>
            <input type='datetime-local' required value={endsAt} onChange={(e) => setEndsAt(e.target.value)}
              className={inputClasses()} style={inputStyle} />
          </Field>
        </div>
        <div className='grid grid-cols-2 gap-3'>
          <Field label='Grace (min)'>
            <input type='number' min={0} max={180} value={gracePeriodMin} onChange={(e) => setGracePeriodMin(e.target.value)}
              className={inputClasses()} style={inputStyle} />
          </Field>
          <Field label='Auto-checkout (min)'>
            <input type='number' min={0} max={1440} value={autoCheckoutMin} onChange={(e) => setAutoCheckoutMin(e.target.value)}
              className={inputClasses()} style={inputStyle} />
          </Field>
        </div>
      </Section>

      <Section title='Check-in methods' lockedHint={locked('allowed_check_in_methods') ? 'Pause the event to edit.' : null}>
        <div className='flex flex-wrap gap-2'>
          {ALL_METHODS.map((m) => (
            <Pill key={m}
              active={methods.includes(m)}
              disabled={locked('allowed_check_in_methods') || isEnded}
              onClick={() => toggleArr(setMethods, methods, m)}>
              {m}
            </Pill>
          ))}
        </div>
        {methods.includes('PIN') && (
          <div className='mt-3 flex items-center gap-3'>
            <label className='text-xs' style={{ color: 'var(--muted)' }}>New PIN (optional)</label>
            <input type='text' inputMode='numeric' maxLength={6} value={pin}
              placeholder='leave blank to keep current'
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className={inputClasses() + ' font-mono tracking-widest'} style={inputStyle} />
            <button type='button' onClick={handleResetPin}
              className='text-xs px-3 py-1 cursor-pointer'
              style={{ background: 'var(--bg2)', border: '1.5px solid var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-btn)' }}>
              Reset & show
            </button>
          </div>
        )}
      </Section>

      <Section title='Allowed roles' lockedHint={locked('allowed_roles') ? 'Pause the event to edit.' : null}>
        <div className='flex flex-wrap gap-2'>
          {availableRoles.map((r) => (
            <Pill key={r}
              active={roles.includes(r)}
              disabled={locked('allowed_roles') || isEnded}
              onClick={() => toggleArr(setRoles, roles, r)}>
              {r.replace('leader', '')}
            </Pill>
          ))}
        </div>
      </Section>

      <Section title='Geofence' lockedHint={locked('geofence') ? 'Pause the event to edit.' : null}>
        {locked('geofence') || isEnded ? (
          <p className='m-0 px-4 py-2.5 text-sm' style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-btn)', color: 'var(--muted)' }}>
            {geofence?.type === 'circle' ? `Circle · ${geofence.radiusM} m` : `Polygon · ${geofence?.polygon?.length || 0} vertices`}
          </p>
        ) : (
          geofence && <GeoFencePicker value={geofence} onChange={setGeofence} />
        )}
      </Section>

      {error && (
        <div
          className='p-3 text-sm text-center'
          style={{ background: 'rgba(232,96,74,0.1)', color: 'var(--coral)', border: '1px solid rgba(232,96,74,0.2)', borderRadius: 'var(--radius-btn)' }}
        >
          {error}
        </div>
      )}
      {saved && (
        <div
          className='p-3 text-sm text-center'
          style={{ background: 'rgba(46,203,143,0.1)', color: 'var(--green)', border: '1px solid rgba(46,203,143,0.3)', borderRadius: 'var(--radius-btn)' }}
        >
          Saved.
        </div>
      )}

      <div className='flex gap-2'>
        <button
          type='button'
          onClick={() => navigate(`/events/${eventId}`)}
          className='btn-pill btn-secondary flex-1 py-3 text-sm font-semibold cursor-pointer'
        >
          Cancel
        </button>
        <button
          type='submit'
          disabled={saving}
          className='btn-pill btn-primary flex-1 py-3 text-sm font-semibold cursor-pointer disabled:opacity-50'
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  )
}

const inputStyle = { background: 'var(--bg2)', border: '1.5px solid var(--border)', color: 'var(--text)' }
const inputClasses = () => 'input-field'

function Section({ title, lockedHint, children }: { title: string; lockedHint?: string | null; children: ReactNode }) {
  return (
    <section className='flex flex-col gap-3'>
      <div className='flex items-baseline justify-between gap-2'>
        <p className='eyebrow m-0'>{title}</p>
        {lockedHint && <p className='text-[10px] m-0' style={{ color: 'var(--amber)' }}>{lockedHint}</p>}
      </div>
      {children}
    </section>
  )
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='flex flex-col gap-1.5'>
      <label className='text-xs font-bold uppercase tracking-widest' style={{ color: 'var(--muted)' }}>{label}</label>
      {children}
    </div>
  )
}
function Pill({ active, onClick, children, disabled }: { active: boolean; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      type='button'
      onClick={onClick}
      disabled={disabled}
      className='px-3 py-1.5 text-xs font-semibold cursor-pointer disabled:cursor-not-allowed disabled:opacity-50'
      style={{
        background: active ? 'var(--cta-bg)' : 'var(--bg2)',
        color: active ? 'var(--cta-text)' : 'var(--text)',
        border: '1.5px solid var(--border)',
        borderRadius: 'var(--radius-pill)',
      }}
    >
      {children}
    </button>
  )
}
function Centered({ children }: { children: ReactNode }) {
  return (
    <div className='py-12 text-center'>
      {children}
    </div>
  )
}

// Convert ISO timestamp → local-tz string formatted for <input type="datetime-local">
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}
