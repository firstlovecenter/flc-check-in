import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import GeoFencePicker from './GeoFencePicker'
import { getCurrentUser, formatName } from '../../utils/auth'
import { createEvent, snapshotEventScopeMembers, bulkUpsertMemberProfiles } from '../../utils/supabaseCheckins'
import { generatePin } from '../../utils/checkinsCrypto'
import {
  resolveCurrentMember, getAdminScopes, allowedRolesForScope, getMembersInScope, memberToProfileRow,
  searchChurches, type ChurchSearchResult,
} from '../../utils/membersApi'
import type { GeofenceInput } from '../../types/app'

interface AdminScope { level: string; id: string; name: string }

const ALL_METHODS = ['QR', 'PIN', 'FACE_ID', 'MANUAL']

export default function CreateEventForm() {
  const navigate = useNavigate()
  const user = getCurrentUser()
  const isSuperAdmin = !!user?.isSuperAdmin

  const [scopes, setScopes] = useState<AdminScope[]>([])
  const [scopesLoading, setScopesLoading] = useState(true)
  const [scopesError, setScopesError] = useState<string | null>(null)

  // Superadmin search-picker state. Superadmins can create events for any
  // church in the denomination, not just their own admin scopes.
  const [superSearch, setSuperSearch] = useState('')
  const [superResults, setSuperResults] = useState<ChurchSearchResult[]>([])
  const [superSearching, setSuperSearching] = useState(false)
  const [superSelected, setSuperSelected] = useState<AdminScope | null>(null)

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

  const [recurrencePattern, setRecurrencePattern] = useState<'none' | 'weekly' | 'biweekly' | 'monthly'>('none')
  const [recurrenceCount, setRecurrenceCount] = useState<number | string>(4)

  const [submitting, setSubmitting] = useState(false)
  const [submitProgress, setSubmitProgress] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Fetch the admin's eligible scopes from FLC member graph.
  // Superadmins skip this — they pick any church via the search picker below.
  useEffect(() => {
    if (isSuperAdmin) { setScopesLoading(false); return }
    let cancelled = false
    ;(async () => {
      try {
        const member = await resolveCurrentMember(user)
        if (cancelled) return
        const adminScopes = getAdminScopes(member, user)
        setScopes(adminScopes)
        if (adminScopes.length > 0) setScopeId(`${adminScopes[0].level}:${adminScopes[0].id}`)
      } catch (err: any) {
        if (!cancelled) setScopesError(err.message)
      } finally {
        if (!cancelled) setScopesLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [user.userId, isSuperAdmin])

  // Debounced church search for superadmins.
  useEffect(() => {
    if (!isSuperAdmin) return
    const q = superSearch.trim()
    if (q.length < 2) { setSuperResults([]); return }
    let cancelled = false
    setSuperSearching(true)
    const t = setTimeout(async () => {
      try {
        const results = await searchChurches(q, 8)
        if (!cancelled) setSuperResults(results)
      } catch {
        if (!cancelled) setSuperResults([])
      } finally {
        if (!cancelled) setSuperSearching(false)
      }
    }, 300)
    return () => { cancelled = true; clearTimeout(t) }
  }, [superSearch, isSuperAdmin])

  const selectedScope = useMemo(() => {
    // Superadmin: their picker's selection wins.
    if (isSuperAdmin) return superSelected
    if (!scopeId) return null
    const [level, id] = scopeId.split(':')
    return scopes.find((s) => s.level === level && s.id === id) || null
  }, [isSuperAdmin, superSelected, scopeId, scopes])

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
      const occurrences = buildOccurrences(startsAt, endsAt, recurrencePattern, Number(recurrenceCount))
      const seriesId = occurrences.length > 1 ? crypto.randomUUID() : undefined
      let firstEventId: string | null = null

      for (let i = 0; i < occurrences.length; i++) {
        if (occurrences.length > 1) setSubmitProgress(`Creating ${i + 1} of ${occurrences.length}…`)
        const { eventId } = await createEvent({
          name,
          venueName: venueName.trim() || null,
          scopeLevel: selectedScope.level,
          scopeChurchId: selectedScope.id,
          scopeChurchName: selectedScope.name,
          startsAt: occurrences[i].startsAt,
          endsAt: occurrences[i].endsAt,
          gracePeriodMin: Number(gracePeriodMin),
          autoCheckoutMin: Number(autoCheckoutMin),
          allowedCheckInMethods: methods,
          allowedRoles: roles,
          geofence,
          pin: methods.includes('PIN') ? pin : null,
          createdBy: { id: user.userId, name: formatName(user) },
          seriesId,
          seriesIndex: i + 1,
        })
        if (i === 0) {
          firstEventId = eventId
          // Snapshot scope members only for the first occurrence.
          ;(async () => {
            try {
              const scopeMembers = await getMembersInScope({ level: selectedScope.level, churchId: selectedScope.id })
              const rows = scopeMembers.map(memberToProfileRow)
              const ids = rows.map((r: any) => r.id).filter(Boolean)
              await Promise.all([snapshotEventScopeMembers(eventId, ids), bulkUpsertMemberProfiles(rows)])
            } catch { /* non-critical */ }
          })()
        }
      }
      navigate(`/admin/events/${firstEventId}`, { replace: true })
    } catch (err: any) {
      setError(err.message || 'Create failed')
    } finally {
      setSubmitting(false)
      setSubmitProgress('')
    }
  }

  // Friendly empty state — strictly only admins reach this form (RequireAdmin
  // guards the route), so this is the rare case where they have admin roles
  // but no concrete admin scope on the member graph.
  // Superadmins skip this — they pick any church via the search picker.
  if (!isSuperAdmin && !scopesLoading && scopes.length === 0) {
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

        {/* Superadmin: search-any-church picker. Superadmins are not bound
            to their own admin scopes — they can create events for any
            church in the denomination. */}
        {isSuperAdmin && (
          <div className='flex flex-col gap-2'>
            {superSelected ? (
              <div
                className='px-4 py-3 flex items-center justify-between gap-3'
                style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-btn)' }}
              >
                <div className='min-w-0'>
                  <p className='eyebrow m-0'>{superSelected.level}</p>
                  <p className='text-sm font-semibold m-0 mt-0.5 truncate' style={{ color: 'var(--text)' }}>
                    {superSelected.name}
                  </p>
                </div>
                <button
                  type='button'
                  onClick={() => { setSuperSelected(null); setSuperSearch(''); setSuperResults([]) }}
                  className='text-xs px-2.5 py-1 cursor-pointer shrink-0'
                  style={{ background: 'transparent', color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: 'var(--radius-pill)' }}
                >Change</button>
              </div>
            ) : (
              <div style={{ position: 'relative' }}>
                <input
                  type='text'
                  value={superSearch}
                  onChange={(e) => setSuperSearch(e.target.value)}
                  placeholder='🔍 Search any church (council, stream, campus, oversight, denomination)…'
                  className='input-field'
                  autoComplete='off'
                />
                {superSearching && (
                  <p className='text-xs mt-1' style={{ color: 'var(--muted)' }}>Searching…</p>
                )}
                {superResults.length > 0 && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 'calc(100% + 4px)',
                      left: 0, right: 0,
                      zIndex: 100,
                      background: 'var(--card)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-btn)',
                      maxHeight: 320,
                      overflowY: 'auto',
                      boxShadow: 'var(--shadow-2)',
                    }}
                  >
                    {superResults.map((r) => (
                      <button
                        key={`${r.level}:${r.id}`}
                        type='button'
                        onClick={() => {
                          setSuperSelected({ level: r.level, id: r.id, name: r.name })
                          setSuperResults([])
                          setSuperSearch('')
                        }}
                        className='w-full text-left px-3 py-2.5 cursor-pointer'
                        style={{
                          background: 'transparent',
                          border: 'none',
                          borderBottom: '1px solid var(--border)',
                          color: 'var(--text)',
                          fontFamily: 'var(--sans)',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg2)')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                      >
                        <div className='text-sm font-semibold truncate'>{r.name}</div>
                        <div className='text-xs truncate' style={{ color: 'var(--muted)', marginTop: 2 }}>
                          {r.level}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                {!superSearching && superSearch.trim().length >= 2 && superResults.length === 0 && (
                  <p className='text-xs mt-1' style={{ color: 'var(--muted)' }}>No matches.</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Non-superadmin: the user's own admin scopes. */}
        {!isSuperAdmin && scopes.length === 1 && selectedScope && (
          <div
            className='px-4 py-3'
            style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-btn)' }}
          >
            <p className='eyebrow m-0'>{selectedScope.level}</p>
            <p className='text-sm font-semibold m-0 mt-0.5' style={{ color: 'var(--text)' }}>{selectedScope.name}</p>
          </div>
        )}
        {!isSuperAdmin && scopes.length > 1 && (
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

      <Section title='Recurrence'>
        <div className='flex flex-wrap gap-2'>
          {(['none', 'weekly', 'biweekly', 'monthly'] as const).map((p) => (
            <Pill key={p} active={recurrencePattern === p} onClick={() => setRecurrencePattern(p)}>
              {p === 'none' ? 'None' : p === 'weekly' ? 'Weekly' : p === 'biweekly' ? 'Bi-weekly' : 'Monthly'}
            </Pill>
          ))}
        </div>
        {recurrencePattern !== 'none' && (
          <div className='flex flex-col gap-3 mt-1'>
            <Field label='Number of occurrences'>
              <input
                type='number' min={2} max={52} value={recurrenceCount}
                onChange={(e) => setRecurrenceCount(e.target.value)}
                className='input-field'
              />
            </Field>
            <RecurrencePreview startsAt={startsAt} endsAt={endsAt} pattern={recurrencePattern} count={Number(recurrenceCount)} />
          </div>
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

      <button
        type='submit'
        disabled={submitting || !selectedScope}
        className='btn-pill btn-primary w-full py-4 font-semibold disabled:opacity-50 cursor-pointer'
      >
        {submitting
          ? (submitProgress || 'Creating…')
          : recurrencePattern !== 'none'
            ? `Create ${Math.max(2, Number(recurrenceCount))} events`
            : 'Create event'}
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

type RecurrencePattern = 'none' | 'weekly' | 'biweekly' | 'monthly'

function buildOccurrences(
  startsAt: string,
  endsAt: string,
  pattern: RecurrencePattern,
  count: number,
): Array<{ startsAt: Date; endsAt: Date }> {
  const start = new Date(startsAt)
  const end = new Date(endsAt)
  const duration = end.getTime() - start.getTime()
  if (pattern === 'none' || count < 2) return [{ startsAt: start, endsAt: end }]
  const clamp = Math.max(2, Math.min(52, count))
  return Array.from({ length: clamp }, (_, i) => {
    let oStart: Date
    if (i === 0) {
      oStart = start
    } else if (pattern === 'weekly') {
      oStart = new Date(start); oStart.setDate(oStart.getDate() + i * 7)
    } else if (pattern === 'biweekly') {
      oStart = new Date(start); oStart.setDate(oStart.getDate() + i * 14)
    } else {
      oStart = new Date(start); oStart.setMonth(oStart.getMonth() + i)
    }
    return { startsAt: oStart, endsAt: new Date(oStart.getTime() + duration) }
  })
}

function RecurrencePreview({ startsAt, endsAt, pattern, count }: {
  startsAt: string; endsAt: string; pattern: RecurrencePattern; count: number
}) {
  const occurrences = buildOccurrences(startsAt, endsAt, pattern, count)
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
  return (
    <div className='flex flex-col gap-1 mt-1'>
      <p className='text-xs' style={{ color: 'var(--muted)' }}>{occurrences.length} events will be created:</p>
      <div
        className='flex flex-col gap-0.5 rounded-md overflow-hidden'
        style={{ border: '1px solid var(--border)', background: 'var(--bg2)', maxHeight: 180, overflowY: 'auto' }}
      >
        {occurrences.map((o, i) => (
          <div
            key={i}
            className='flex items-center gap-2 px-3 py-2 text-xs'
            style={{ borderBottom: i < occurrences.length - 1 ? '1px solid var(--border)' : 'none' }}
          >
            <span
              className='shrink-0 font-mono font-bold text-center'
              style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--accent)', color: 'var(--bg)', fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >{i + 1}</span>
            <span style={{ color: 'var(--text)' }}>{fmt(o.startsAt)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
