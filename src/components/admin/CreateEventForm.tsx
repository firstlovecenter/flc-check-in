import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import Spinner from '../Spinner'
import GeoFencePicker from './GeoFencePicker'
import { getCurrentUser, formatName } from '../../utils/auth'
import {
  createEvent,
  listSpecialGroups, listSpecialGroupMembers, type SpecialGroup,
} from '../../utils/supabaseCheckins'
import { generatePin } from '../../utils/checkinsCrypto'
import { snapshotEventScopeFromGraph } from '../../utils/eventScopeSnapshot'
import {
  resolveCurrentMember, getCreatorScopes, allowedRolesForScope,
  searchChurches, getChildChurches, childScopeLevel, type ChurchSearchResult,
} from '../../utils/membersApi'
import type { GeofenceInput } from '../../types/app'
import { cn } from '../../lib/utils'
import { useChurchFocus } from '../../contexts/ChurchFocusContext'

interface AdminScope { level: string; id: string; name: string }

const ALL_METHODS = ['QR', 'PIN', 'MANUAL']

export default function CreateEventForm() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const user = getCurrentUser()
  const isSuperAdmin = !!user?.isSuperAdmin
  const { focusedScope } = useChurchFocus()

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
  const [targetScopeId, setTargetScopeId] = useState('')
  const [targetScopeOptions, setTargetScopeOptions] = useState<AdminScope[]>([])
  const [targetScopesLoading, setTargetScopesLoading] = useState(false)
  const [startsAt, setStartsAt] = useState(defaultStartsAt())
  const [durationPreset, setDurationPreset] = useState<'30' | '60' | '120' | 'custom'>('60')
  const [customMinutes, setCustomMinutes] = useState<number | string>(90)
  const durationMin = durationPreset === 'custom' ? Math.max(1, Number(customMinutes) || 60) : Number(durationPreset)
  const endsAt = useMemo(() => {
    if (!startsAt) return ''
    const start = new Date(startsAt)
    if (isNaN(start.getTime())) return ''
    return new Date(start.getTime() + durationMin * 60_000).toISOString().slice(0, 16)
  }, [startsAt, durationMin])
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
  const [step, setStep] = useState(0)

  // Fetch the admin's eligible scopes from FLC member graph.
  // Superadmins skip this — they pick any church via the search picker below.
  // If a church scope is focused on the home screen, pre-select it here.
  useEffect(() => {
    if (isSuperAdmin) { setScopesLoading(false); return }
    let cancelled = false
    ;(async () => {
      try {
        const member = await resolveCurrentMember(user)
        if (cancelled) return
        const creatorScopes = getCreatorScopes(member, user)
        setScopes(creatorScopes)
        if (creatorScopes.length > 0) {
          const match = focusedScope
            ? creatorScopes.find((s) => s.id === focusedScope.id)
            : null
          const defaultScope = match ?? creatorScopes[0]
          setScopeId(`${defaultScope.level}:${defaultScope.id}`)
        }
      } catch (err: any) {
        if (!cancelled) setScopesError(err.message)
      } finally {
        if (!cancelled) setScopesLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [user.userId, isSuperAdmin]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const selectedTargetScope = useMemo<AdminScope | null>(() => {
    if (isSuperAdmin) return selectedScope
    if (!targetScopeId) return selectedScope
    return targetScopeOptions.find((s) => `${s.level}:${s.id}` === targetScopeId) || selectedScope
  }, [isSuperAdmin, selectedScope, targetScopeId, targetScopeOptions])

  useEffect(() => {
    if (isSuperAdmin || !selectedScope) {
      setTargetScopeOptions([])
      setTargetScopeId('')
      return
    }
    let cancelled = false
    const seen = new Set<string>()
    const out: AdminScope[] = []
    const push = (s: AdminScope) => {
      const key = `${s.level}:${s.id}`
      if (seen.has(key)) return
      seen.add(key)
      out.push(s)
    }
    setTargetScopesLoading(true)
    ;(async () => {
      try {
        const queue: AdminScope[] = [selectedScope]
        while (queue.length > 0) {
          const current = queue.shift()!
          push(current)
          const childLevel = childScopeLevel(current.level)
          if (!childLevel) continue
          const children = await getChildChurches({ level: current.level, id: current.id })
          for (const c of children) {
            queue.push({ level: childLevel, id: c.id, name: c.name })
          }
        }
        if (!cancelled) {
          setTargetScopeOptions(out)
          setTargetScopeId((prev) => {
            if (prev && out.some((s) => `${s.level}:${s.id}` === prev)) return prev
            return `${selectedScope.level}:${selectedScope.id}`
          })
        }
      } catch {
        if (!cancelled) {
          setTargetScopeOptions([selectedScope])
          setTargetScopeId(`${selectedScope.level}:${selectedScope.id}`)
        }
      } finally {
        if (!cancelled) setTargetScopesLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [isSuperAdmin, selectedScope?.id, selectedScope?.level])

  // Roles available for this scope = leadership levels strictly below it.
  const availableRoles = useMemo(
    () => {
      if (isSuperAdmin && superMode === 'group') {
        // Group events span any level — expose all roles so the admin can restrict.
        return allowedRolesForScope('denomination')
      }
      return selectedTargetScope ? allowedRolesForScope(selectedTargetScope.level) : []
    },
    [selectedTargetScope, isSuperAdmin, superMode]
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

  function nextStep() {
    setError(null)
    if (step === 0) {
      if (!name.trim()) { setError(t('createEvent.errors.nameRequired')); return }
      if (isSuperAdmin && superMode === 'churches' && superScopes.length === 0) { setError(t('createEvent.errors.scopeRequired')); return }
      if (isSuperAdmin && superMode === 'group' && selectedGroupIds.length === 0) { setError(t('createEvent.errors.groupRequired')); return }
      if (!isSuperAdmin && !selectedTargetScope) { setError(t('createEvent.errors.chooseScope')); return }
    }
    if (step === 1 && (!startsAt || !endsAt || new Date(endsAt) <= new Date(startsAt))) {
      setError(t('createEvent.errors.invalidSchedule')); return
    }
    if (step === 2) {
      if (methods.length === 0) { setError(t('createEvent.errors.methodRequired')); return }
      if (roles.length === 0 && !(isSuperAdmin && superMode === 'group')) { setError(t('createEvent.errors.roleRequired')); return }
      if (geofence.type === 'polygon' && (geofence.polygon || []).length < 3) { setError(t('createEvent.errors.polygonVertices')); return }
    }
    setStep((current) => Math.min(3, current + 1))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)

    if (isSuperAdmin && superMode === 'churches' && superScopes.length === 0) {
      setError(t('createEvent.errors.scopeRequired')); return
    }
    if (isSuperAdmin && superMode === 'group' && selectedGroupIds.length === 0) {
      setError(t('createEvent.errors.groupRequired')); return
    }
    if (!isSuperAdmin && !selectedTargetScope) { setError(t('createEvent.errors.noScope')); return }
    if (methods.length === 0) { setError(t('createEvent.errors.methodRequired')); return }
    if (roles.length === 0 && !(isSuperAdmin && superMode === 'group')) { setError(t('createEvent.errors.roleRequired')); return }
    if (geofence.type === 'polygon') {
      if ((geofence.polygon || []).length < 3) {
        setError(t('createEvent.errors.polygonVertices')); return
      }
    }

    // Determine the DB anchor scope.
    // Multi-church: use first scope as anchor; snapshot will union all.
    // People mode: denomination anchor; snapshot seeded with specific IDs.
    const anchorScope = selectedTargetScope!

    setSubmitting(true)
    try {
      const occurrences = buildOccurrences(startsAt, endsAt, recurrencePattern, Number(recurrenceCount))
      const seriesId = occurrences.length > 1 ? crypto.randomUUID() : undefined
      let firstEventId: string | null = null

      for (let i = 0; i < occurrences.length; i++) {
        if (occurrences.length > 1) setSubmitProgress(t('createEvent.progress.creating', { current: i + 1, total: occurrences.length }))
        const { eventId } = await createEvent({
          name,
          venueName: venueName.trim() || null,
          scopeLevel: anchorScope.level,
          scopeChurchId: anchorScope.id,
          scopeChurchName: anchorScope.name,
          startsAt: occurrences[i].startsAt,
          endsAt: occurrences[i].endsAt,
          allowedCheckInMethods: methods,
          allowedRoles: roles,
          geofence,
          pin: methods.includes('PIN') ? pin : null,
          createdBy: { id: user.userId, name: [user.firstName, user.lastName].filter(Boolean).join(' ') || formatName(user) },
          seriesId,
          seriesIndex: i + 1,
          isPublic: isSuperAdmin ? isPublic : true,
        })
        if (i === 0) {
          firstEventId = eventId
          // Snapshot scope members + write profiles before navigating so the
          // event dashboard sees a complete member list on the very first load.
          setSubmitProgress(t('createEvent.progress.preparingMembers'))
          try {
            // The ONE graph probe in an event's life. Shared with the edit
            // page's "Refresh eligible list" so both paths build the snapshot
            // identically. See utils/eventScopeSnapshot.ts.
            const useGroups = isSuperAdmin && superMode === 'group' && selectedGroupIds.length > 0
            await snapshotEventScopeFromGraph({
              eventId,
              groupIds: useGroups ? selectedGroupIds : [],
              scopes: useGroups ? [] : (isSuperAdmin ? superScopes : [anchorScope]),
            })
          } catch {
            // Non-critical here: the event still exists, and an admin can run
            // "Refresh eligible list" from the edit page to build the snapshot.
          }
        }
      }
      navigate(`/admin/events/${firstEventId}`, { replace: true })
    } catch (err: any) {
      setError(err.message || t('createEvent.errors.createFailed'))
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
        <p className='mb-2 text-destructive'>{t('createEvent.noScopeTitle')}</p>
        <p>{t('createEvent.noScopeBody')}</p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className='flex flex-col gap-5'>
      <div className='grid grid-cols-4 gap-1' aria-label={t('createEvent.stepAria', { current: step + 1, total: 4 })}>
        {([
          t('createEvent.steps.basics'),
          t('createEvent.steps.schedule'),
          t('createEvent.steps.rules'),
          t('createEvent.steps.review'),
        ] as const).map((label, index) => (
          <div key={label} className='min-w-0'>
            <div className={cn('h-1 rounded-full', index <= step ? 'bg-primary' : 'bg-border')} />
            <p className={cn('m-0 mt-1 truncate text-center text-[11px] font-medium', index === step ? 'text-foreground' : 'text-muted-foreground')}>{label}</p>
          </div>
        ))}
      </div>

      {error && (
        <div className='rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-center text-sm text-destructive' role='alert'>
          {error}
        </div>
      )}

      <fieldset disabled={step !== 0} className={cn('contents', step !== 0 && 'hidden')}>
      <Section title={t('createEvent.sections.event')}>
        <Field label={t('createEvent.fields.name')}>
          <input type='text' required value={name} onChange={(e) => setName(e.target.value)}
            className='input-field'
            placeholder={t('createEvent.fields.namePlaceholder')} />
        </Field>
        <Field label={t('createEvent.fields.venue')}>
          <input type='text' value={venueName} onChange={(e) => setVenueName(e.target.value)}
            className='input-field'
            placeholder={t('createEvent.fields.venuePlaceholder')} />
        </Field>
      </Section>

      {/* Scope: hidden if exactly 1 admin scope; dropdown if 2+ */}
      <Section title={t('createEvent.sections.scope')}>
        {scopesLoading && <Spinner />}
        {scopesError && <p className='text-sm text-destructive'>{scopesError}</p>}

        {/* Superadmin: multi-scope church picker OR saved group. */}
        {isSuperAdmin && (
          <div className='flex flex-col gap-3'>
            {/* Mode toggle */}
            <div className='flex gap-2'>
              <Pill active={superMode === 'churches'} onClick={() => setSuperMode('churches')}>{t('createEvent.scopeModes.churches')}</Pill>
              <Pill active={superMode === 'group'} onClick={() => setSuperMode('group')}>{t('createEvent.scopeModes.group')}</Pill>
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
                        <span className='text-[11px] uppercase tracking-wide opacity-70'>{s.level}</span>
                        {s.name}
                        <button
                          type='button'
                          onClick={() => removeSuperScope(`${s.level}:${s.id}`)}
                          className='ml-0.5 cursor-pointer border-0 bg-transparent p-0 text-sm leading-none opacity-70 hover:opacity-100'
                          aria-label={t('createEvent.removeScopeAria', { name: s.name })}
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
                    placeholder={t('createEvent.churchSearchPlaceholder')}
                    className='input-field'
                    autoComplete='off'
                  />
                  {superSearching && (
                    <p className='text-xs mt-1 text-muted-foreground'>{t('common.searching')}</p>
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
                    <p className='text-xs mt-1 text-muted-foreground'>{t('empty.noMatches')}</p>
                  )}
                </div>
              </div>
            )}

            {superMode === 'group' && (
              <div className='flex flex-col gap-2'>
                {groupsLoading && <Spinner />}
                {!groupsLoading && groups.length === 0 && (
                  <p className='text-xs text-muted-foreground'>
                    {t('createEvent.noGroupsYet')}
                  </p>
                )}
                {!groupsLoading && groups.length > 0 && (
                  <>
                    <p className='text-xs text-muted-foreground'>
                      {t('createEvent.selectGroupsHint')}
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

        {!isSuperAdmin && selectedScope && (
          <Field label={t('createEvent.fields.createForChurch')}>
            {targetScopesLoading ? (
              <Spinner />
            ) : (
              <select
                required
                value={targetScopeId || `${selectedScope.level}:${selectedScope.id}`}
                onChange={(e) => setTargetScopeId(e.target.value)}
                className='input-field'
              >
                {targetScopeOptions.map((s) => (
                  <option key={`${s.level}:${s.id}`} value={`${s.level}:${s.id}`}>
                    {s.level.toUpperCase()} · {s.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
      </Section>
      </fieldset>

      <fieldset disabled={step !== 1} className={cn('contents', step !== 1 && 'hidden')}>
      <Section title={t('createEvent.sections.timeWindow')}>
        <Field label={t('createEvent.fields.starts')}>
          <input type='datetime-local' required value={startsAt} onChange={(e) => setStartsAt(e.target.value)}
            className='input-field' />
        </Field>
        <Field label={t('createEvent.fields.duration')}>
          <div className='flex flex-wrap gap-2'>
            {([
              { label: t('createEvent.fields.duration30'), value: '30' },
              { label: t('createEvent.fields.duration60'), value: '60' },
              { label: t('createEvent.fields.duration120'), value: '120' },
              { label: t('createEvent.fields.durationCustom'), value: 'custom' },
            ] as const).map((opt) => (
              <Pill key={opt.value} active={durationPreset === opt.value} onClick={() => setDurationPreset(opt.value)}>
                {opt.label}
              </Pill>
            ))}
          </div>
          {durationPreset === 'custom' && (
            <div className='mt-2 flex items-center gap-2'>
              <input
                type='number' min={1} max={1440} value={customMinutes}
                onChange={(e) => setCustomMinutes(e.target.value)}
                className='input-field w-24'
              />
              <span className='text-sm text-muted-foreground'>{t('common.minutes')}</span>
            </div>
          )}
          {endsAt && (
            <p className='mt-1 text-xs text-muted-foreground'>
              {t('createEvent.fields.endsAt', { time: formatLocalTime(endsAt) })}
            </p>
          )}
        </Field>
      </Section>
      </fieldset>

      <fieldset disabled={step !== 2} className={cn('contents', step !== 2 && 'hidden')}>
      <Section title={t('createEvent.sections.checkInMethods')}>
        <div className='flex flex-wrap gap-2'>
          {ALL_METHODS.map((m) => (
            <Pill key={m} active={methods.includes(m)} onClick={() => toggleArr(setMethods, methods, m)}>
              {m}
            </Pill>
          ))}
        </div>
        {methods.includes('PIN') && (
          <div className='mt-3 flex items-center gap-3'>
            <label className='text-xs text-muted-foreground'>{t('createEvent.fields.pin')}</label>
            <input type='text' inputMode='numeric' maxLength={6} value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g,'').slice(0, 6))}
              className='input-field font-mono tracking-widest flex-1' />
            <button type='button' onClick={() => setPin(generatePin())}
              className='text-xs px-3 py-1 cursor-pointer btn-pill btn-secondary'>
              {t('createEvent.fields.regenerate')}
            </button>
          </div>
        )}
      </Section>

      {!(isSuperAdmin && superMode === 'group') && <Section title={t('createEvent.sections.allowedRoles')}>
        {availableRoles.length === 0 ? (
          <p className='text-sm text-muted-foreground'>
            {t('createEvent.noLeaderLevels')}
          </p>
        ) : (
          <>
            <p className='text-xs mb-1 text-muted-foreground'>
              {t('createEvent.leadersWithin', { level: selectedTargetScope?.level })}
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

      <Section title={t('createEvent.sections.geofence')}>
        <GeoFencePicker value={geofence} onChange={setGeofence} />
      </Section>
      </fieldset>

      <fieldset disabled={step !== 3} className={cn('contents', step !== 3 && 'hidden')}>
      <Section title={t('createEvent.sections.recurrence')}>
        <div className='flex flex-wrap gap-2'>
          {(['none', 'weekly', 'biweekly', 'monthly'] as const).map((p) => (
            <Pill key={p} active={recurrencePattern === p} onClick={() => setRecurrencePattern(p)}>
              {t(`createEvent.recurrence.${p}`)}
            </Pill>
          ))}
        </div>
        {recurrencePattern !== 'none' && (
          <div className='flex flex-col gap-3 mt-1'>
            <Field label={t('createEvent.fields.occurrences')}>
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
        <Section title={t('createEvent.sections.visibility')}>
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
                {isPublic ? t('createEvent.visibility.publicTitle') : t('createEvent.visibility.privateTitle')}
              </p>
              <p className='m-0 mt-0.5 text-xs text-muted-foreground'>
                {isPublic
                  ? t('createEvent.visibility.publicBody')
                  : t('createEvent.visibility.privateBody')}
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

      <Section title={t('createEvent.sections.review')}>
        <div className='rounded-2xl border border-border bg-secondary p-4'>
          <h3 className='m-0 text-base font-semibold text-foreground'>{name || t('createEvent.review.untitled')}</h3>
          <p className='m-0 mt-2 text-sm leading-6 text-muted-foreground'>
            {recurrencePattern === 'none' ? t('createEvent.review.oneEvent') : t('createEvent.review.multipleEvents', { count: Math.max(2, Number(recurrenceCount)), pattern: recurrencePattern })}
            {' · '}{new Date(startsAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            {' · '}{durationPreset === 'custom' ? customMinutes : durationPreset} {t('common.minutes')}
            {venueName.trim() ? ` · ${venueName.trim()}` : ''}
          </p>
          <p className='m-0 mt-2 text-sm leading-6 text-muted-foreground'>
            {t('createEvent.review.checkInMethods', { methods: methods.join(' or ') })} · {geofence.type === 'circle' ? t('createEvent.review.geofenceCircle', { radius: geofence.radiusM }) : t('createEvent.review.geofenceCustom')}
            {roles.length ? ` · ${t('createEvent.review.leaders', { roles: roles.map((role) => role.replace('leader', '')).join(', ') })}` : ''}
          </p>
          <p className='m-0 mt-2 text-sm leading-6 text-muted-foreground'>
            {t('createEvent.review.scope', { scope: isSuperAdmin && superMode === 'churches' ? superScopes.map((scope) => scope.name).join(', ') : selectedTargetScope?.name || t('createEvent.review.selectedGroup') })}
          </p>
        </div>
      </Section>

      <button
        type='submit'
        disabled={
          submitting ||
          (isSuperAdmin && superMode === 'churches' && superScopes.length === 0) ||
          (isSuperAdmin && superMode === 'group' && (selectedGroupIds.length === 0 || !selectedScope)) ||
          (!isSuperAdmin && !selectedScope)
          || (!isSuperAdmin && !selectedTargetScope)
        }
        className='btn-pill btn-primary w-full py-4 font-semibold disabled:opacity-50 cursor-pointer'
      >
        {submitting
          ? (submitProgress || t('createEvent.creating'))
          : recurrencePattern !== 'none'
            ? t('createEvent.createMultiple', { count: Math.max(2, Number(recurrenceCount)) })
            : t('createEvent.createSingle')}
      </button>
      </fieldset>

      <div className='sticky bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-20 flex gap-2 rounded-2xl border border-border bg-card/95 p-2 shadow-lg backdrop-blur-xl lg:bottom-4'>
        {step > 0 && (
          <button type='button' onClick={() => { setError(null); setStep((current) => current - 1) }} className='btn-pill btn-secondary min-h-11 flex-1 px-4 font-semibold'>{t('common.back')}</button>
        )}
        {step < 3 && (
          <button type='button' onClick={nextStep} className='btn-pill btn-primary min-h-11 flex-1 px-4 font-semibold'>{t('common.continue')}</button>
        )}
      </div>
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
      className={cn(
        'chip cursor-pointer px-3 py-1.5 text-xs font-semibold transition-[color,background-color,transform] active:scale-95',
        active
          ? 'bg-primary text-primary-foreground active:brightness-90'
          : 'hover:bg-primary/12 active:bg-primary/18',
      )}
    >
      {children}
    </button>
  )
}

// Default start time: now, formatted for <input type="datetime-local">.
function defaultStartsAt() {
  const d = new Date()
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}

// Format an ISO datetime-local string as a human-readable time (e.g. "3:30 PM").
function formatLocalTime(isoLocal: string): string {
  const timePart = isoLocal.slice(11, 16)
  const [hStr, mStr] = timePart.split(':')
  const h = parseInt(hStr, 10)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${mStr} ${ampm}`
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
  const { t } = useTranslation()
  const occurrences = buildOccurrences(startsAt, endsAt, pattern, count)
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
  return (
    <div className='flex flex-col gap-1 mt-1'>
      <p className='text-xs text-muted-foreground'>{t('createEvent.previewCount', { count: occurrences.length })}</p>
      <div className='flex max-h-[180px] flex-col gap-0.5 overflow-hidden overflow-y-auto rounded-md border border-border bg-secondary'>
        {occurrences.map((o, i) => (
          <div
            key={i}
            className='flex items-center gap-2 border-b border-border px-3 py-2 text-xs last:border-b-0'
          >
            <span className='flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground'>
              {i + 1}
            </span>
            <span className='text-foreground'>{fmt(o.startsAt)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
