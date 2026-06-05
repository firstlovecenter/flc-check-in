import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import Spinner from '../Spinner'
import GeoFencePicker from './GeoFencePicker'
import { getCurrentUser, formatName } from '../../utils/auth'
import {
  createEvent, snapshotEventScopeMembers, bulkUpsertMemberProfiles,
  listSpecialGroups, listSpecialGroupMembers, type SpecialGroup,
} from '../../utils/supabaseCheckins'
import { generatePin } from '../../utils/checkinsCrypto'
import {
  resolveCurrentMember, getAdminScopes, allowedRolesForScope, getMembersInScope, memberToProfileRow,
  searchChurches, type ChurchSearchResult,
} from '../../utils/membersApi'
import type { GeofenceInput } from '../../types/app'
import { cn } from '../../lib/utils'

interface AdminScope { level: string; id: string; name: string }

const ALL_METHODS = ['QR', 'PIN', 'MANUAL']

export default function CreateEventForm() {
  const navigate = useNavigate()
  const user = getCurrentUser()
  const isSuperAdmin = !!user?.isSuperAdmin

  const [scopes, setScopes] = useState<AdminScope[]>([])
  const [scopesLoading, setScopesLoading] = useState(true)
  const [scopesError, setScopesError] = useState<string | null>(null)

  // Superadmin scope mode: 'churches' = one or more church scopes,
  // 'group' = a saved special group.
  const [superMode, setSuperMode] = useState<'churches' | 'group'>('churches')

  // Superadmin church search state — supports adding multiple scopes.
  const [superSearch, setSuperSearch] = useState('')
  const [superResults, setSuperResults] = useState<ChurchSearchResult[]>([])
  const [superSearching, setSuperSearching] = useState(false)
  // Selected church scopes (multiple allowed).
  const [superScopes, setSuperScopes] = useState<AdminScope[]>([])

  // Superadmin group mode — pick a saved special group.
  const [groups, setGroups] = useState<SpecialGroup[]>([])
  const [groupsLoading, setGroupsLoading] = useState(false)
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([])

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

  // Superadmin-only: whether this event appears on the public QR page.
  // Defaults true for church-scope events, false for special-group events.
  const [isPublic, setIsPublic] = useState(true)

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

  // Debounced church search for superadmins (churches mode).
  useEffect(() => {
    if (!isSuperAdmin || superMode !== 'churches') return
    const q = superSearch.trim()
    if (q.length < 2) { setSuperResults([]); return }
    let cancelled = false
    setSuperSearching(true)
    const t = setTimeout(async () => {
      try {
        const results = await searchChurches(q, 10)
        if (!cancelled) setSuperResults(results)
      } catch {
        if (!cancelled) setSuperResults([])
      } finally {
        if (!cancelled) setSuperSearching(false)
      }
    }, 300)
    return () => { cancelled = true; clearTimeout(t) }
  }, [superSearch, isSuperAdmin, superMode])

  // Load groups when superadmin switches to group mode.
  useEffect(() => {
    if (!isSuperAdmin || superMode !== 'group') return
    setGroupsLoading(true)
    listSpecialGroups()
      .then(setGroups)
      .catch(() => setGroups([]))
      .finally(() => setGroupsLoading(false))
  }, [isSuperAdmin, superMode])

  // Default is_public to false for group-mode events, true for church-scope events.
  useEffect(() => {
    if (!isSuperAdmin) return
    setIsPublic(superMode !== 'group')
  }, [isSuperAdmin, superMode])

  // The "primary" scope used for roles display and event creation anchor.
  // For superadmin churches mode: first selected scope.
  // For superadmin group mode: denomination from user's JWT (anchor for DB row).
  // For regular admin: derived from scopeId / scopes list.
  const selectedScope = useMemo<AdminScope | null>(() => {
    if (isSuperAdmin) {
      if (superMode === 'churches') return superScopes[0] || null
      // group mode — use special_group sentinel scope so the event is invisible
      // to regular admins (their scope filter never generates a special_group clause).
      const selectedGroups = groups.filter((g) => selectedGroupIds.includes(g.id))
      if (selectedGroups.length === 0) return null
      return {
        level: 'special_group',
        id: selectedGroupIds.join(','),
        name: selectedGroups.map((g) => g.name).join(', '),
      }
    }
    if (!scopeId) return null
    const [level, id] = scopeId.split(':')
    return scopes.find((s) => s.level === level && s.id === id) || null
  }, [isSuperAdmin, superMode, superScopes, selectedGroupIds, groups, scopeId, scopes])

  // Roles available for this scope = leadership levels strictly below it.
  const availableRoles = useMemo(
    () => {
      if (isSuperAdmin && superMode === 'group') {
        // Group events span any level — expose all roles so the admin can restrict.
        return allowedRolesForScope('denomination')
      }
      return selectedScope ? allowedRolesForScope(selectedScope.level) : []
    },
    [selectedScope, isSuperAdmin, superMode]
  )

  // When the scope changes, reset the role selection to "all eligible roles checked."
  useEffect(() => {
    setRoles(availableRoles)
  }, [availableRoles.join(',')]) // eslint-disable-line

  function toggleArr(setter, current, value) {
    setter(current.includes(value) ? current.filter((v) => v !== value) : [...current, value])
  }

  function addSuperScope(r: ChurchSearchResult) {
    const key = `${r.level}:${r.id}`
    if (superScopes.some((s) => `${s.level}:${s.id}` === key)) return
    setSuperScopes((prev) => [...prev, { level: r.level, id: r.id, name: r.name }])
    setSuperSearch('')
    setSuperResults([])
  }

  function removeSuperScope(key: string) {
    setSuperScopes((prev) => prev.filter((s) => `${s.level}:${s.id}` !== key))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)

    if (isSuperAdmin && superMode === 'churches' && superScopes.length === 0) {
      setError('Add at least one church scope.'); return
    }
    if (isSuperAdmin && superMode === 'group' && selectedGroupIds.length === 0) {
      setError('Select at least one group.'); return
    }
    if (!isSuperAdmin && !selectedScope) { setError('No admin scope.'); return }
    if (methods.length === 0) { setError('Pick at least one check-in method.'); return }
    if (roles.length === 0 && !(isSuperAdmin && superMode === 'group')) { setError('Pick at least one allowed role.'); return }
    if (geofence.type === 'polygon') {
      if ((geofence.polygon || []).length < 3) {
        setError('Polygon needs at least 3 vertices.'); return
      }
    }

    // Determine the DB anchor scope.
    // Multi-church: use first scope as anchor; snapshot will union all.
    // People mode: denomination anchor; snapshot seeded with specific IDs.
    const anchorScope = selectedScope!

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
          scopeLevel: anchorScope.level,
          scopeChurchId: anchorScope.id,
          scopeChurchName: anchorScope.name,
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
          isPublic: isSuperAdmin ? isPublic : true,
        })
        if (i === 0) {
          firstEventId = eventId
          // Snapshot scope members only for the first occurrence.
          ;(async () => {
            try {
              let memberIds: string[] = []
              let profileRows: any[] = []

              if (isSuperAdmin && superMode === 'group' && selectedGroupIds.length > 0) {
                // Group mode: union members across all selected groups, deduplicated.
                const results = await Promise.all(selectedGroupIds.map(listSpecialGroupMembers))
                const seen = new Set<string>()
                memberIds = results.flat().filter((m) => {
                  if (seen.has(m.member_id)) return false
                  seen.add(m.member_id); return true
                }).map((m) => m.member_id)
              } else {
                // Church scopes: union members from all selected scopes.
                const scopesToFetch = isSuperAdmin ? superScopes : [anchorScope]
                const results = await Promise.all(
                  scopesToFetch.map((s) => getMembersInScope({ level: s.level, churchId: s.id }))
                )
                const allMembers = results.flat()
                // Deduplicate by member id.
                const seen = new Set<string>()
                const unique = allMembers.filter((m) => {
                  if (!m?.id || seen.has(m.id)) return false
                  seen.add(m.id); return true
                })
                profileRows = unique.map(memberToProfileRow)
                memberIds = profileRows.map((r: any) => r.id).filter(Boolean)
              }

              await Promise.all([
                snapshotEventScopeMembers(eventId, memberIds),
                profileRows.length ? bulkUpsertMemberProfiles(profileRows) : Promise.resolve(),
              ])
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
      <div className='surface-card p-5 text-center text-sm text-muted-foreground'>
        <p className='mb-2 text-destructive'>No admin scope found.</p>
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
        {scopesLoading && <Spinner />}
        {scopesError && <p className='text-sm text-destructive'>{scopesError}</p>}

        {/* Superadmin: multi-scope church picker OR saved group. */}
        {isSuperAdmin && (
          <div className='flex flex-col gap-3'>
            {/* Mode toggle */}
            <div className='flex gap-2'>
              <Pill active={superMode === 'churches'} onClick={() => setSuperMode('churches')}>Church scopes</Pill>
              <Pill active={superMode === 'group'} onClick={() => setSuperMode('group')}>Special group</Pill>
            </div>

            {superMode === 'churches' && (
              <div className='flex flex-col gap-2'>
                {/* Selected scopes chips */}
                {superScopes.length > 0 && (
                  <div className='flex flex-wrap gap-1.5'>
                    {superScopes.map((s) => (
                      <span
                        key={`${s.level}:${s.id}`}
                        className='chip flex items-center gap-1.5 border-primary/30 bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground'
                      >
                        <span className='text-[9px] uppercase tracking-wide opacity-70'>{s.level}</span>
                        {s.name}
                        <button
                          type='button'
                          onClick={() => removeSuperScope(`${s.level}:${s.id}`)}
                          className='ml-0.5 cursor-pointer border-0 bg-transparent p-0 text-sm leading-none opacity-70 hover:opacity-100'
                          aria-label={`Remove ${s.name}`}
                        >×</button>
                      </span>
                    ))}
                  </div>
                )}
                {/* Church search */}
                <div className='relative'>
                  <input
                    type='text'
                    value={superSearch}
                    onChange={(e) => setSuperSearch(e.target.value)}
                    placeholder='Search council, stream, campus, oversight, denomination…'
                    className='input-field'
                    autoComplete='off'
                  />
                  {superSearching && (
                    <p className='text-xs mt-1 text-muted-foreground'>Searching…</p>
                  )}
                  {superResults.length > 0 && (
                    <SearchDropdown>
                      {superResults.map((r) => {
                        const key = `${r.level}:${r.id}`
                        const already = superScopes.some((s) => `${s.level}:${s.id}` === key)
                        return (
                          <SearchDropdownItem
                            key={key}
                            label={r.name}
                            sublabel={r.level}
                            disabled={already}
                            onClick={() => addSuperScope(r)}
                          />
                        )
                      })}
                    </SearchDropdown>
                  )}
                  {!superSearching && superSearch.trim().length >= 2 && superResults.length === 0 && (
                    <p className='text-xs mt-1 text-muted-foreground'>No matches.</p>
                  )}
                </div>
              </div>
            )}

            {superMode === 'group' && (
              <div className='flex flex-col gap-2'>
                {groupsLoading && <Spinner />}
                {!groupsLoading && groups.length === 0 && (
                  <p className='text-xs text-muted-foreground'>
                    No groups yet. Create one from the Special Groups page first.
                  </p>
                )}
                {!groupsLoading && groups.length > 0 && (
                  <>
                    <p className='text-xs text-muted-foreground'>
                      Select one or more groups — members from all selected groups will be in scope.
                    </p>
                    <div className='flex flex-col gap-1.5'>
                      {groups.map((g) => {
                        const selected = selectedGroupIds.includes(g.id)
                        return (
                          <button
                            key={g.id}
                            type='button'
                            onClick={() => setSelectedGroupIds((prev) =>
                              prev.includes(g.id) ? prev.filter((id) => id !== g.id) : [...prev, g.id]
                            )}
                            className={cn('check-row', selected && 'check-row--selected')}
                          >
                            <div className='check-row__box'>
                              {selected && (
                                <svg viewBox='0 0 10 8' width='10' height='8' fill='none' aria-hidden>
                                  <path d='M1 4l3 3 5-6' stroke='hsl(var(--primary))' strokeWidth='1.5' strokeLinecap='round' strokeLinejoin='round' />
                                </svg>
                              )}
                            </div>
                            <div className='min-w-0 flex-1'>
                              <p className='m-0 truncate text-sm font-semibold'>{g.name}</p>
                              {g.description && (
                                <p className={cn('m-0 mt-0.5 truncate text-xs opacity-80', selected ? 'text-primary-foreground' : 'text-muted-foreground')}>{g.description}</p>
                              )}
                            </div>
                            <span className='chip shrink-0 px-2 py-0.5 text-xs font-semibold normal-case tracking-normal'>
                              {g.member_count ?? 0}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Non-superadmin: the user's own admin scopes. */}
        {!isSuperAdmin && scopes.length === 1 && selectedScope && (
          <div
            className='px-4 py-3 rounded-lg border border-border bg-secondary'
          >
            <p className='eyebrow m-0'>{selectedScope.level}</p>
            <p className='text-sm font-semibold m-0 mt-0.5 text-foreground'>{selectedScope.name}</p>
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
            <label className='text-xs text-muted-foreground'>PIN</label>
            <input type='text' inputMode='numeric' maxLength={6} value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g,'').slice(0, 6))}
              className='input-field font-mono tracking-widest flex-1' />
            <button type='button' onClick={() => setPin(generatePin())}
              className='text-xs px-3 py-1 cursor-pointer btn-pill btn-secondary'>
              Regenerate
            </button>
          </div>
        )}
      </Section>

      {!(isSuperAdmin && superMode === 'group') && <Section title='Allowed roles'>
        {availableRoles.length === 0 ? (
          <p className='text-sm text-muted-foreground'>
            No leader levels exist below this scope.
          </p>
        ) : (
          <>
            <p className='text-xs mb-1 text-muted-foreground'>
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
      </Section>}

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

      {isSuperAdmin && (
        <Section title='Visibility'>
          <button
            type='button'
            onClick={() => setIsPublic((v) => !v)}
            className={cn(
              'flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border px-4 py-3 text-left transition-colors',
              isPublic ? 'border-primary bg-secondary' : 'border-border bg-secondary',
            )}
          >
            <div>
              <p className='m-0 text-sm font-semibold text-foreground'>
                {isPublic ? 'Visible on public page' : 'Hidden from public page'}
              </p>
              <p className='m-0 mt-0.5 text-xs text-muted-foreground'>
                {isPublic
                  ? 'Anyone can scan the QR code from the public events page.'
                  : 'Only invited members and superadmins can see this event.'}
              </p>
            </div>
            <div
              className={cn(
                'relative h-6 w-11 shrink-0 rounded-full transition-colors',
                isPublic ? 'bg-primary' : 'bg-border',
              )}
              aria-hidden
            >
              <div
                className={cn(
                  'absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white transition-[left]',
                  isPublic ? 'left-[23px]' : 'left-0.5',
                )}
              />
            </div>
          </button>
        </Section>
      )}

      {error && (
        <div
          className='p-3 text-sm text-center rounded-lg border border-destructive/20 bg-destructive/10 text-destructive'
        >
          {error}
        </div>
      )}

      <button
        type='submit'
        disabled={
          submitting ||
          (isSuperAdmin && superMode === 'churches' && superScopes.length === 0) ||
          (isSuperAdmin && superMode === 'group' && (selectedGroupIds.length === 0 || !selectedScope)) ||
          (!isSuperAdmin && !selectedScope)
        }
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

function SearchDropdown({ children }: { children: ReactNode }) {
  return <div className='search-dropdown max-h-80'>{children}</div>
}

function SearchDropdownItem({ label, sublabel, disabled, onClick }: {
  label: string; sublabel?: string; disabled?: boolean; onClick: () => void
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      disabled={disabled}
      className='search-dropdown-item block w-full'
    >
      <div className='text-sm font-semibold truncate'>{label}</div>
      {sublabel && <div className='text-xs truncate mt-0.5 text-muted-foreground'>{sublabel}</div>}
    </button>
  )
}

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
      <label className='text-xs font-bold uppercase tracking-widest text-muted-foreground'>{label}</label>
      {children}
    </div>
  )
}
function Pill({ active, onClick, children }) {
  return (
    <button
      type='button'
      onClick={onClick}
      className={cn('chip cursor-pointer px-3 py-1.5 text-xs font-semibold', active && 'border-primary bg-primary text-primary-foreground')}
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
      <p className='text-xs text-muted-foreground'>{occurrences.length} events will be created:</p>
      <div className='flex max-h-[180px] flex-col gap-0.5 overflow-hidden overflow-y-auto rounded-md border border-border bg-secondary'>
        {occurrences.map((o, i) => (
          <div
            key={i}
            className='flex items-center gap-2 border-b border-border px-3 py-2 text-xs last:border-b-0'
          >
            <span className='flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground'>
              {i + 1}
            </span>
            <span className='text-foreground'>{fmt(o.startsAt)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
