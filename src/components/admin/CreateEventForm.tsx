import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import GeoFencePicker from './GeoFencePicker'
import { getCurrentUser, formatName } from '../../utils/auth'
import { createEvent, snapshotEventScopeMembers, bulkUpsertMemberProfiles } from '../../utils/supabaseCheckins'
import { generatePin } from '../../utils/checkinsCrypto'
import {
  resolveCurrentMember, getAdminScopes, allowedRolesForScope, getMembersInScope, memberToProfileRow,
} from '../../utils/membersApi'
import type { GeofenceInput } from '../../types/app'

interface AdminScope { level: string; id: string; name: string }

const ALL_METHODS = ['QR', 'PIN', 'FACE_ID', 'MANUAL']

export default function CreateEventForm() {
  const navigate = useNavigate()
  const user = getCurrentUser()

  const [scopes, setScopes] = useState<AdminScope[]>([])
  const [scopesLoading, setScopesLoading] = useState(true)
  const [scopesError, setScopesError] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [venueName, setVenueName] = useState('')
  // Selected admin scope (always one of `scopes`). Stored as "level:id".
  const [scopeId, setScopeId] = useState('')
  const [startsAt, setStartsAt] = useState(defaultStartsAt())
  const [endsAt, setEndsAt] = useState(defaultEndsAt())
  const [gracePeriodMin, setGracePeriodMin] = useState<number | string>(15)
  const [autoCheckoutMin, setAutoCheckoutMin] = useState<number | string>(0)
  const [methods, setMethods] = useState<string[]>(['QR', 'PIN'])
  const [roles, setRoles] = useState<string[]>([])
  const [pin, setPin] = useState(generatePin())
  const [geofence, setGeofence] = useState<GeofenceInput>({ type: 'circle', centerLat: 5.6037, centerLng: -0.1870, radiusM: 50 })

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fetch the admin's eligible scopes from FLC member graph
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const member = await resolveCurrentMember(user)
        if (cancelled) return
        const adminScopes = getAdminScopes(member)
        setScopes(adminScopes)
        if (adminScopes.length > 0) setScopeId(`${adminScopes[0].level}:${adminScopes[0].id}`)
      } catch (err: any) {
        if (!cancelled) setScopesError(err.message)
      } finally {
        if (!cancelled) setScopesLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [user.userId])

  const selectedScope = useMemo(() => {
    if (!scopeId) return null
    const [level, id] = scopeId.split(':')
    return scopes.find((s) => s.level === level && s.id === id) || null
  }, [scopeId, scopes])

  // Roles available for this scope = leadership levels strictly below it.
  const availableRoles = useMemo(
    () => (selectedScope ? allowedRolesForScope(selectedScope.level) : []),
    [selectedScope]
  )

  // When the scope changes, reset the role selection to "all eligible roles
  // checked." Avoids showing roles from a previous scope.
  useEffect(() => {
    setRoles(availableRoles)
  }, [availableRoles.join(',')]) // eslint-disable-line

  function toggleArr(setter, current, value) {
    setter(current.includes(value) ? current.filter((v) => v !== value) : [...current, value])
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    if (!selectedScope) { setError('No admin scope.'); return }
    if (methods.length === 0) { setError('Pick at least one check-in method.'); return }
    if (roles.length === 0) { setError('Pick at least one allowed role.'); return }
    if (geofence.type === 'polygon') {
      if ((geofence.polygon || []).length < 3) {
        setError('Polygon needs at least 3 vertices.'); return
      }
    }
    setSubmitting(true)
    try {
      const { eventId } = await createEvent({
        name,
        venueName: venueName.trim() || null,
        scopeLevel: selectedScope.level,
        scopeChurchId: selectedScope.id,
        scopeChurchName: selectedScope.name,
        startsAt: new Date(startsAt),
        endsAt: new Date(endsAt),
        gracePeriodMin: Number(gracePeriodMin),
        autoCheckoutMin: Number(autoCheckoutMin),
        allowedCheckInMethods: methods,
        allowedRoles: roles,
        geofence,
        pin: methods.includes('PIN') ? pin : null,
        createdBy: { id: user.userId, name: formatName(user) },
      })
      // Fire-and-forget: snapshot every member currently in scope by their
      // stable graph ID. Done in the background so navigation is instant.
      // If this fails the dashboard falls back to a live graph query and
      // re-saves the snapshot on first load.
      ;(async () => {
        try {
          const scopeMembers = await getMembersInScope({
            level: selectedScope.level,
            churchId: selectedScope.id,
          })
          const rows = scopeMembers.map(memberToProfileRow)
          const ids = rows.map((r: any) => r.id).filter(Boolean)
          await Promise.all([
            snapshotEventScopeMembers(eventId, ids),
            bulkUpsertMemberProfiles(rows),
          ])
        } catch {
          // Non-critical — dashboard will fall back to the live graph.
        }
      })()
      navigate(`/admin/events/${eventId}`, { replace: true })
    } catch (err: any) {
      setError(err.message || 'Create failed')
    } finally {
      setSubmitting(false)
    }
  }

  // Friendly empty state — strictly only admins reach this form (RequireAdmin
  // guards the route), so this is the rare case where they have admin roles
  // but no concrete admin scope on the member graph.
  if (!scopesLoading && scopes.length === 0) {
    return (
      <div
        className='p-5 text-sm text-center'
        style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-btn)', color: 'var(--muted)' }}
      >
        <p className='mb-2' style={{ color: 'var(--coral)' }}>No admin scope found.</p>
        <p>You don't appear in the FLC member graph as an admin of any church. Ask your stream lead to update your relationships.</p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className='flex flex-col gap-5'>
      <Section title='Event'>
        <Field label='Name'>
          <input type='text' required value={name} onChange={(e) => setName(e.target.value)}
            className='input-field'
            placeholder='e.g. Sunday Bacenta Leaders Meeting' />
        </Field>
        <Field label='Venue / Location name'>
          <input type='text' value={venueName} onChange={(e) => setVenueName(e.target.value)}
            className='input-field'
            placeholder='e.g. First Love Center, The Qodesh' />
        </Field>
      </Section>

      {/* Scope: hidden if exactly 1 admin scope; dropdown if 2+ */}
      <Section title='Scope'>
        {scopesLoading && <p className='text-sm' style={{ color: 'var(--muted)' }}>Loading your scopes…</p>}
        {scopesError && <p className='text-sm' style={{ color: 'var(--coral)' }}>{scopesError}</p>}
        {scopes.length === 1 && selectedScope && (
          <div
            className='px-4 py-3'
            style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-btn)' }}
          >
            <p className='eyebrow m-0'>{selectedScope.level}</p>
            <p className='text-sm font-semibold m-0 mt-0.5' style={{ color: 'var(--text)' }}>{selectedScope.name}</p>
          </div>
        )}
        {scopes.length > 1 && (
          <select required value={scopeId} onChange={(e) => setScopeId(e.target.value)}
            className='input-field'>
            {scopes.map((s) => (
              <option key={`${s.level}:${s.id}`} value={`${s.level}:${s.id}`}>
                {s.level.toUpperCase()} · {s.name}
              </option>
            ))}
          </select>
        )}
      </Section>

      <Section title='Time window'>
        <div className='grid grid-cols-2 gap-3'>
          <Field label='Starts'>
            <input type='datetime-local' required value={startsAt} onChange={(e) => setStartsAt(e.target.value)}
              className='input-field' />
          </Field>
          <Field label='Ends'>
            <input type='datetime-local' required value={endsAt} onChange={(e) => setEndsAt(e.target.value)}
              className='input-field' />
          </Field>
        </div>
        <div className='grid grid-cols-2 gap-3'>
          <Field label='Grace period (min)'>
            <input type='number' min={0} max={180} value={gracePeriodMin} onChange={(e) => setGracePeriodMin(e.target.value)}
              className='input-field' />
          </Field>
          <Field label='Auto-checkout (min)'>
            <input type='number' min={0} max={1440} value={autoCheckoutMin} onChange={(e) => setAutoCheckoutMin(e.target.value)}
              className='input-field' />
          </Field>
        </div>
      </Section>

      <Section title='Check-in methods'>
        <div className='flex flex-wrap gap-2'>
          {ALL_METHODS.map((m) => (
            <Pill key={m} active={methods.includes(m)} onClick={() => toggleArr(setMethods, methods, m)}>
              {m}
            </Pill>
          ))}
        </div>
        {methods.includes('PIN') && (
          <div className='mt-3 flex items-center gap-3'>
            <label className='text-xs' style={{ color: 'var(--muted)' }}>PIN</label>
            <input type='text' inputMode='numeric' maxLength={6} value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g,'').slice(0, 6))}
              className='input-field font-mono tracking-widest flex-1' />
            <button type='button' onClick={() => setPin(generatePin())}
              className='text-xs px-3 py-1 cursor-pointer'
              style={{ background: 'var(--bg2)', border: '1.5px solid var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-btn)' }}>
              Regenerate
            </button>
          </div>
        )}
      </Section>

      <Section title='Allowed roles'>
        {availableRoles.length === 0 ? (
          <p className='text-sm' style={{ color: 'var(--muted)' }}>
            No leader levels exist below this scope.
          </p>
        ) : (
          <>
            <p className='text-xs mb-1' style={{ color: 'var(--muted)' }}>
              Leaders within this {selectedScope?.level}.
            </p>
            <div className='flex flex-wrap gap-2'>
              {availableRoles.map((r) => (
                <Pill key={r} active={roles.includes(r)} onClick={() => toggleArr(setRoles, roles, r)}>
                  {r.replace('leader', '')}
                </Pill>
              ))}
            </div>
          </>
        )}
      </Section>

      <Section title='Geofence'>
        <GeoFencePicker value={geofence} onChange={setGeofence} />
      </Section>

      {error && (
        <div
          className='p-3 text-sm text-center'
          style={{ background: 'rgba(232,96,74,0.1)', color: 'var(--coral)', border: '1px solid rgba(232,96,74,0.2)', borderRadius: 'var(--radius-btn)' }}
        >
          {error}
        </div>
      )}

      <button
        type='submit'
        disabled={submitting || scopes.length === 0}
        className='btn-pill btn-primary w-full py-4 font-semibold disabled:opacity-50 cursor-pointer'
      >
        {submitting ? 'Creating…' : 'Create event'}
      </button>
    </form>
  )
}

const inputStyle = { background: 'var(--bg2)', border: '1.5px solid var(--border)', color: 'var(--text)' }

function Section({ title, children }) {
  return (
    <section className='flex flex-col gap-3'>
      <p className='eyebrow m-0'>{title}</p>
      {children}
    </section>
  )
}
function Field({ label, children }) {
  return (
    <div className='flex flex-col gap-1.5'>
      <label className='text-xs font-bold uppercase tracking-widest' style={{ color: 'var(--muted)' }}>{label}</label>
      {children}
    </div>
  )
}
function Pill({ active, onClick, children }) {
  return (
    <button
      type='button'
      onClick={onClick}
      className='px-3 py-1.5 text-xs font-semibold cursor-pointer'
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

// Default times: now (rounded to current minute) and now + 1h, formatted for
// <input type="datetime-local"> which expects a tz-naive local string.
function defaultStartsAt() {
  const d = new Date()
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}
function defaultEndsAt() {
  const d = new Date(Date.now() + 60 * 60 * 1000)
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}
