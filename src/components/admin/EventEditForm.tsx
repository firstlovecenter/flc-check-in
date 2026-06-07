import type { ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Spinner from '../Spinner'
import GeoFencePicker from './GeoFencePicker'
import CheckInAdminControls from './CheckInAdminControls'
import { Alert } from '../ui/alert'
import { cn } from '../../lib/utils'
import { getEvent, updateEvent, resetPin } from '../../utils/supabaseCheckins'
import { allowedRolesForScope } from '../../utils/membersApi'
import { generatePin } from '../../utils/checkinsCrypto'
import type { CheckinEventRow, GeofenceInput } from '../../types/app'

const ALL_METHODS = ['QR', 'PIN', 'MANUAL']

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
  const [durationPreset, setDurationPreset]   = useState<'30' | '60' | '120' | 'custom'>('60')
  const [customMinutes, setCustomMinutes]     = useState<number | string>(90)
  const [gracePeriodMin, setGracePeriodMin]   = useState<number | string>(15)
  const [autoCheckoutMin, setAutoCheckoutMin] = useState<number | string>(0)
  const [methods, setMethods]                 = useState<string[]>([])
  const [roles, setRoles]                     = useState<string[]>([])
  const [geofence, setGeofence]               = useState<GeofenceInput | null>(null)
  const [pin, setPin]                         = useState('')

  const durationMin = durationPreset === 'custom' ? Math.max(1, Number(customMinutes) || 60) : Number(durationPreset)
  const endsAt = useMemo(() => {
    if (!startsAt) return ''
    const start = new Date(startsAt)
    if (isNaN(start.getTime())) return ''
    return new Date(start.getTime() + durationMin * 60_000).toISOString().slice(0, 16)
  }, [startsAt, durationMin])

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
        applyDurationFromEvent(evt.starts_at, evt.ends_at, setDurationPreset, setCustomMinutes)
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

  if (error && !event) return <Centered><p className='text-destructive'>{error}</p></Centered>
  if (!event) return <Spinner fullPage />

  return (
    <form onSubmit={handleSubmit} className='flex flex-col gap-5'>
      {/* Lifecycle controls — always at the top */}
      <Section title='Status & controls'>
        <p className='text-xs text-muted-foreground'>
          Current status: <span className='uppercase tracking-wider text-primary'>{event.status}</span>
        </p>
        <CheckInAdminControls event={event} onChange={(updated) => {
          setEvent(updated)
          if (updated.starts_at && updated.ends_at) {
            setStartsAt(toLocalInput(updated.starts_at))
            applyDurationFromEvent(updated.starts_at, updated.ends_at, setDurationPreset, setCustomMinutes)
          }
        }} />
      </Section>

      <Section title='Event'>
        <Field label='Name'>
          <input type='text' required value={name} onChange={(e) => setName(e.target.value)}
            className='input-field' />
        </Field>
        <Field label='Venue / Location name'>
          <input type='text' value={venueName} onChange={(e) => setVenueName(e.target.value)}
            placeholder='e.g. First Love Center, The Qodesh'
            className='input-field' />
        </Field>
        <Field label='Scope (read-only)'>
          <p className='surface-card m-0 rounded-lg px-4 py-2.5 text-sm text-foreground'>
            <span className='uppercase tracking-wider text-primary'>{event.scope_level}</span>
            <span className='text-border'> · </span>
            {event.scope_church_name}
          </p>
        </Field>
      </Section>

      <Section title='Time window'>
        <Field label='Starts'>
          <input type='datetime-local' required value={startsAt} onChange={(e) => setStartsAt(e.target.value)}
            className='input-field' />
        </Field>
        <Field label='Duration'>
          <div className='flex flex-wrap gap-2'>
            {(['30', '60', '120', 'custom'] as const).map((preset) => (
              <Pill key={preset} active={durationPreset === preset} onClick={() => setDurationPreset(preset)}>
                {preset === '30' ? '30 min' : preset === '60' ? '1 hour' : preset === '120' ? '2 hours' : 'Custom'}
              </Pill>
            ))}
          </div>
          {durationPreset === 'custom' && (
            <div className='flex items-center gap-2 mt-1'>
              <input
                type='number'
                min={1}
                max={1440}
                value={customMinutes}
                onChange={(e) => setCustomMinutes(e.target.value)}
                className='input-field w-24'
              />
              <span className='text-xs text-muted-foreground'>minutes</span>
            </div>
          )}
          {endsAt && (
            <p className='text-xs text-muted-foreground mt-0.5'>
              Ends at <span className='font-semibold text-foreground'>{formatLocalTime(endsAt)}</span>
            </p>
          )}
        </Field>
        <div className='grid grid-cols-2 gap-3'>
          <Field label='Grace (min)'>
            <input type='number' min={0} max={180} value={gracePeriodMin} onChange={(e) => setGracePeriodMin(e.target.value)}
              className='input-field' />
          </Field>
          <Field label='Auto-checkout (min)'>
            <input type='number' min={0} max={1440} value={autoCheckoutMin} onChange={(e) => setAutoCheckoutMin(e.target.value)}
              className='input-field' />
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
            <label className='text-xs text-muted-foreground'>New PIN (optional)</label>
            <input type='text' inputMode='numeric' maxLength={6} value={pin}
              placeholder='leave blank to keep current'
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className='input-field font-mono tracking-widest' />
            <button type='button' onClick={handleResetPin} className='btn-pill btn-secondary px-3 py-1 text-xs'>
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
          <p className='surface-card m-0 rounded-lg px-4 py-2.5 text-sm text-muted-foreground'>
            {geofence?.type === 'circle' ? `Circle · ${geofence.radiusM} m` : `Polygon · ${geofence?.polygon?.length || 0} vertices`}
          </p>
        ) : (
          geofence && <GeoFencePicker value={geofence} onChange={setGeofence} />
        )}
      </Section>

      {error && <Alert variant='destructive' className='text-center'>{error}</Alert>}
      {saved && <Alert variant='success' className='text-center'>Saved.</Alert>}

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

function Section({ title, lockedHint, children }: { title: string; lockedHint?: string | null; children: ReactNode }) {
  return (
    <section className='flex flex-col gap-3'>
      <div className='flex items-baseline justify-between gap-2'>
        <p className='eyebrow m-0'>{title}</p>
        {lockedHint && <p className='text-[10px] m-0 text-warning'>{lockedHint}</p>}
      </div>
      {children}
    </section>
  )
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='flex flex-col gap-1.5'>
      <label className='text-xs font-bold uppercase tracking-widest text-muted-foreground'>{label}</label>
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
      className={cn(
        'chip cursor-pointer px-3 py-1.5 text-xs font-semibold transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-50',
        active
          ? 'bg-primary text-primary-foreground active:brightness-90'
          : 'hover:bg-primary/12 active:bg-primary/18',
      )}
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

// Format a datetime-local string (YYYY-MM-DDTHH:MM) as a human-readable time
function formatLocalTime(isoLocal: string): string {
  if (!isoLocal) return ''
  const [, timePart] = isoLocal.split('T')
  if (!timePart) return ''
  const [hStr, mStr] = timePart.split(':')
  const h = parseInt(hStr, 10)
  const m = mStr
  const period = h < 12 ? 'AM' : 'PM'
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${m} ${period}`
}

// Derive the duration preset from an event's start and end timestamps
function applyDurationFromEvent(
  startsIso: string | null | undefined,
  endsIso: string | null | undefined,
  setPreset: (p: '30' | '60' | '120' | 'custom') => void,
  setCustomMin: (m: number) => void,
) {
  if (!startsIso || !endsIso) return
  const mins = Math.round((new Date(endsIso).getTime() - new Date(startsIso).getTime()) / 60_000)
  if (mins === 30) setPreset('30')
  else if (mins === 60) setPreset('60')
  else if (mins === 120) setPreset('120')
  else { setPreset('custom'); setCustomMin(mins > 0 ? mins : 60) }
}
