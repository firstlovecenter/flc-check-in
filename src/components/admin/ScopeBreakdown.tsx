import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import Spinner from '../Spinner'
import { format } from 'date-fns'
import ScreenHeader from '../ScreenHeader'
import { PageShell, PageMain } from '../layout/PageShell'
import { CenterCard } from '../layout/CenterCard'
import { cn } from '../../lib/utils'
import {
  childScopeLevel, getChildChurches, getChildScopeLeaders,
  type ChildScopeLeader,
} from '../../utils/membersApi'
import { getCurrentUser, SCOPE_LEVELS } from '../../utils/auth'
import { useEventEligibility } from '../../hooks/useEventEligibility'
import { useRefreshSignal } from '../../hooks/useRefreshSignal'
import { PaginationControls, useClientPagination } from '../PaginationControls'

const NAMES_PAGE_SIZE = 50

function membersWithId(list: any[] | null | undefined): any[] {
  return (list || []).filter((m) => m != null && m.id != null && m.id !== '')
}

export default function ScopeBreakdown({ eventId }) {
  const { t } = useTranslation()
  const user = getCurrentUser()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const drillLevel    = searchParams.get('level')      || null
  const drillChurchId = searchParams.get('churchId')   || null
  const drillChurchName = searchParams.get('churchName') || null

  const [refreshKey, setRefreshKey] = useState(0)
  useRefreshSignal(() => setRefreshKey((k) => k + 1))

  // Same hook, same cache as EventDashboard/EventMembers/FullReport — this is
  // what keeps "who's eligible" and "who's checked in" identical across every
  // screen. A screen with its own bespoke fetch WILL drift from the others.
  const {
    event, eligible, viewerCaps, records,
    error: eligibilityError, initialLoading,
  } = useEventEligibility(eventId, user, { refreshKey })

  const allEligible = useMemo(() => membersWithId(eligible), [eligible])
  const error = eligibilityError

  const [childChurches, setChildChurches] = useState<{ id: string; name: string }[] | null>(null)
  const [childLeaders, setChildLeaders] = useState<Map<string, ChildScopeLeader>>(new Map())
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const viewerScopeIdx  = viewerCaps?.viewerScope ? SCOPE_LEVELS.indexOf(viewerCaps.viewerScope.level) : -1
  const requestedLevel  = (drillLevel || event?.scope_level) as any
  const requestedIdx    = requestedLevel ? SCOPE_LEVELS.indexOf(requestedLevel) : -1
  const canDrillFullEvent = viewerCaps?.canManage || viewerCaps?.canViewFullEvent
  const shouldClamp     = !canDrillFullEvent && viewerScopeIdx >= 0 && requestedIdx > viewerScopeIdx

  const currentLevel    = shouldClamp ? viewerCaps!.viewerScope!.level : requestedLevel
  const currentChurchId = shouldClamp ? viewerCaps!.viewerScope!.id    : (drillChurchId || event?.scope_church_id)
  const currentName     = shouldClamp ? viewerCaps!.viewerScope!.name  : (drillChurchName || event?.scope_church_name || '')

  useEffect(() => {
    if (!currentLevel || !currentChurchId) return
    let cancelled = false
    getChildChurches({ level: currentLevel, id: currentChurchId })
      .then((list) => { if (!cancelled) setChildChurches(list) })
      .catch(() => { if (!cancelled) setChildChurches([]) })
    // Leader photos/names come from the graph's leads* edges (authoritative) —
    // never guessed from profile rows. On failure, cards show no leader
    // rather than the wrong one.
    getChildScopeLeaders({ level: currentLevel, id: currentChurchId })
      .then((map) => { if (!cancelled) setChildLeaders(map) })
      .catch(() => { if (!cancelled) setChildLeaders(new Map()) })
    return () => { cancelled = true }
  }, [currentLevel, currentChurchId])

  const sliceRows = useMemo(() => {
    if (!currentLevel || !currentChurchId) return allEligible
    // At the event's own scope level all eligible members are in scope by
    // construction (seeded from event_scope_members) — skip filtering.
    if (currentLevel === event?.scope_level && currentChurchId === event?.scope_church_id) return allEligible
    const idCol = `${currentLevel}_id`
    return allEligible.filter((m) => {
      // scope_ids captures all paths; flat column only has the primary one.
      const scopeIds: string[] | undefined = (m.scope_ids as any)?.[currentLevel]
      if (scopeIds?.length) return scopeIds.includes(currentChurchId)
      return m[idCol] === currentChurchId
    })
  }, [allEligible, currentLevel, currentChurchId, event?.scope_level, event?.scope_church_id])

  const childLevel = currentLevel ? childScopeLevel(currentLevel) : null

  const { groups, unassignedRows } = useMemo(() => {
    if (!childLevel) return { groups: [], unassignedRows: [] }
    // Still waiting on the graph child list — don't dump every eligible
    // member into a flat "unassigned" list (that is what installed PWAs were
    // showing when getChildChurches was slow/failed vs the browser).
    if (childChurches === null) return { groups: [], unassignedRows: [] }

    const idCol   = `${childLevel}_id`
    const nameCol = `${childLevel}_name`
    const recordByMember = new Map(records.map((r) => [r.member_id, r]))

    // Only two attendance metrics: attended (has a record) and absent.
    // total is kept internally purely to sort the groups by size.
    type GroupStats = {
      id: string; name: string
      total: number; attended: number; absent: number
    }
    const blank = (id: string, name: string): GroupStats => ({ id, name, total: 0, attended: 0, absent: 0 })

    const map = new Map<string, GroupStats>()
    for (const c of childChurches) map.set(c.id, blank(c.id, c.name))

    // Graph child list empty/failed — seed groups from eligible member
    // hierarchy columns so drills still appear (PWA / offline / graph blip).
    if (map.size === 0) {
      for (const m of sliceRows) {
        const scopeChildIds: string[] | undefined = (m.scope_ids as any)?.[childLevel]
        const candidates = scopeChildIds?.length
          ? scopeChildIds
          : (m[idCol] ? [m[idCol] as string] : [])
        for (const id of candidates) {
          if (!id || map.has(id)) continue
          map.set(id, blank(id, (m[nameCol] as string) || id))
        }
      }
    }

    const unassigned: { member: any; record: any; status: string }[] = []
    for (const m of sliceRows) {
      // Resolve which child-level group this member belongs to.
      // scope_ids holds all IDs at each level for multi-path members; the flat
      // column only stores the primary path and may point to the wrong church.
      // Only use IDs that correspond to a known child church (in map) to
      // prevent spurious group entries from cross-hierarchy paths.
      let key: string | null = null
      const scopeChildIds: string[] | undefined = (m.scope_ids as any)?.[childLevel]
      if (scopeChildIds?.length) {
        key = scopeChildIds.find((id) => map.has(id)) ?? null
      }
      if (!key) {
        const flatId: string | undefined = m[idCol]
        key = flatId && map.has(flatId) ? flatId : null
      }
      if (!key) {
        const rec = recordByMember.get(m.id) || null
        const status = rec ? 'Present' : 'Absent'
        unassigned.push({ member: m, record: rec, status })
        continue
      }
      const g = map.get(key)!
      g.total++
      const rec = recordByMember.get(m.id)
      const notStarted = !!event?.starts_at && new Date(event.starts_at) > new Date()
      if (rec) g.attended++
      else if (!notStarted) g.absent++
    }
    const statusOrder = { Present: 0, Absent: 1 }
    return {
      groups: [...map.values()].sort((a, b) => b.total - a.total),
      unassignedRows: unassigned.sort((a, b) => (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3)),
    }
  }, [sliceRows, childLevel, records, childChurches, event?.starts_at])

  const memberRows = useMemo(() => {
    if (currentLevel !== 'governorship' && childLevel !== null && childLevel !== 'bacenta') return []
    const recordByMember = new Map(records.map((r) => [r.member_id, r]))
    return sliceRows.map((m) => {
      const r = recordByMember.get(m.id) || null
      const status = r ? 'Present' : 'Absent'
      return { member: m, record: r, status }
    }).sort((a, b) => {
      const order = { Present: 0, Absent: 1 }
      return (order[a.status] ?? 2) - (order[b.status] ?? 2)
    })
  }, [sliceRows, currentLevel, childLevel, records])

  const memberPage = useClientPagination(
    memberRows,
    NAMES_PAGE_SIZE,
    `${currentLevel}|${currentChurchId}|${memberRows.length}`,
  )

  const backTo = drillLevel ? null : `/events/${eventId}`
  const isMemberList = currentLevel === 'governorship' || childLevel === null || childLevel === 'bacenta'

  if (error) return <CenterCard><p className='text-destructive'>{error}</p></CenterCard>
  if (initialLoading || !event || !viewerCaps) {
    return <Spinner fullPage message={t('scopeBreakdown.loadingEvent')} />
  }
  if (!viewerCaps.canManage && !viewerCaps.canCheckIn && !viewerCaps.canView) {
    return <CenterCard><p className='text-muted-foreground'>{t('scopeBreakdown.notInScope')}</p></CenterCard>
  }

  return (
    <PageShell>
      <ScreenHeader
        title={currentName || t('scopeBreakdown.title')}
        back={backTo ? { to: backTo, label: t('scopeBreakdown.backDashboard') } : undefined}
        onBack={!backTo ? () => navigate(-1) : undefined}
      />
      <PageMain className='flex flex-col gap-3 py-5'>
        <div className='flex items-center justify-between'>
          <p className='eyebrow m-0'>
            {isMemberList
              ? t('scopeBreakdown.memberCount', { count: sliceRows.length })
              : `${t('scopeBreakdown.childCount', { count: groups.length, level: cap(childLevel!) })}${unassignedRows.length > 0 ? t('scopeBreakdown.atThisLevel', { count: unassignedRows.length }) : ''}`}
          </p>
          {!isMemberList && (
            <Link
              to={`/events/${eventId}/members?status=all&level=${currentLevel}&churchId=${currentChurchId}&churchName=${encodeURIComponent(currentName)}`}
              className='text-xs text-primary underline'
            >
              {t('scopeBreakdown.allMembers')}
            </Link>
          )}
        </div>

        {/* ── Scope accordion list ── */}
        {!isMemberList && childChurches === null && (
          <p className='py-8 text-center text-sm text-muted-foreground'>{t('scopeBreakdown.loadingScopes')}</p>
        )}
        {!isMemberList && childChurches !== null && (
          <div className='flex flex-col gap-3'>
            {groups.map((g) => (
              <ScopeCard
                key={g.id}
                group={g}
                childLevel={childLevel!}
                eventId={eventId}
                isExpanded={expandedId === g.id}
                onToggle={() => setExpandedId(expandedId === g.id ? null : g.id)}
                leader={childLeaders.get(g.id) ?? null}
              />
            ))}
            {groups.length === 0 && unassignedRows.length === 0 && (
              <p className='py-6 text-center text-sm text-muted-foreground'>{t('scopeBreakdown.noChildScopes')}</p>
            )}
          </div>
        )}

        {/* ── Unassigned members (scope-level leaders with no child scope) ── */}
        {!isMemberList && childChurches !== null && unassignedRows.length > 0 && (
          <>
            <p className='mt-1 text-xs font-semibold text-muted-foreground'>
              {t('scopeBreakdown.levelMembers', { level: cap(currentLevel!), count: unassignedRows.length })}
            </p>
            <div className='flex flex-col gap-2'>
              {unassignedRows.map(({ member: m, record: r, status }) => (
                <MemberRow key={m.id} member={m} record={r} status={status} />
              ))}
            </div>
          </>
        )}

        {/* ── Member list (governorship / bottom of drill) ── */}
        {isMemberList && memberRows.length === 0 && (
          <p className='mt-4 text-center text-sm text-muted-foreground'>{t('scopeBreakdown.noEligible')}</p>
        )}
        {isMemberList && memberRows.length > 0 && (
          <div className='flex flex-col gap-2'>
            {memberPage.pageItems.map(({ member: m, record: r, status }) => (
              <MemberRow key={m.id} member={m} record={r} status={status} />
            ))}
            <PaginationControls
              page={memberPage.page}
              totalPages={memberPage.totalPages}
              total={memberPage.total}
              pageSize={NAMES_PAGE_SIZE}
              onPageChange={memberPage.setPage}
              noun='names'
              className='mt-2'
            />
          </div>
        )}
      </PageMain>
    </PageShell>
  )
}

// ─── ScopeCard (accordion item) ──────────────────────────────────────────────
// The leader avatar/name comes from the graph's leads* edges via
// getChildScopeLeaders — accurate or absent, never guessed from profiles.

function ScopeCard({
  group, childLevel, eventId, isExpanded, onToggle, leader,
}: {
  group: { id: string; name: string; total: number; attended: number; absent: number }
  childLevel: string
  eventId: string
  isExpanded: boolean
  onToggle: () => void
  leader: { id: string; name: string; pictureUrl: string | null } | null
}) {
  const { t } = useTranslation()
  const leaderName = leader?.name ?? ''
  const initials = leaderName
    ? leaderName.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase()
    : group.name.charAt(0).toUpperCase()

  const drillPath = `/events/${eventId}?scopeLevel=${childLevel}&scopeChurchId=${group.id}&scopeChurchName=${encodeURIComponent(group.name)}`
  const membersBase = `/events/${eventId}/members`
  const scopeQ = `level=${childLevel}&churchId=${group.id}&churchName=${encodeURIComponent(group.name)}`
  const presentLink = `${membersBase}?status=present&${scopeQ}`
  const absentLink  = `${membersBase}?status=absent&${scopeQ}`

  return (
    <div className='overflow-hidden rounded-2xl border border-border bg-card'>
      {/* ── Row header ── */}
      <button
        type='button'
        onClick={onToggle}
        className='flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-muted/40'
      >
        {leader?.pictureUrl ? (
          <img src={leader.pictureUrl} alt={leaderName} className='h-12 w-12 shrink-0 rounded-full object-cover' />
        ) : (
          <div className='flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-bold text-muted-foreground'>
            {initials}
          </div>
        )}
        <div className='min-w-0 flex-1'>
          <p className='m-0 truncate text-sm font-semibold text-foreground'>{group.name}</p>
          {leaderName && (
            <p className='m-0 mt-0.5 truncate text-xs text-muted-foreground'>{leaderName}</p>
          )}
        </div>
        <div className='flex shrink-0 items-center gap-2.5'>
          <span className='tnum text-sm font-bold text-success'>{group.attended}</span>
          <span className='tnum text-sm font-bold text-destructive'>{group.absent}</span>
          <svg
            viewBox='0 0 24 24' width='16' height='16'
            className={cn('shrink-0 text-muted-foreground/60 transition-transform duration-200', isExpanded && 'rotate-180')}
            fill='none' stroke='currentColor' strokeWidth='2'
          >
            <path d='M6 9l6 6 6-6' strokeLinecap='round' strokeLinejoin='round' />
          </svg>
        </div>
      </button>

      {/* ── Expanded content ── */}
      {isExpanded && (
        <div className='border-t border-border px-4 pb-4 pt-3'>
          <div className='overflow-hidden rounded-xl border border-border'>
            <ExpandedStatRow icon='present' label={t('scopeBreakdown.present')} count={group.attended} to={presentLink} />
            <div className='h-px bg-border' />
            <ExpandedStatRow icon='absent'  label={t('scopeBreakdown.absent')}  count={group.absent}   to={absentLink} />
          </div>
          <Link
            to={drillPath}
            className='mt-3 flex items-center justify-end gap-1 text-sm font-semibold text-primary no-underline'
          >
            {t('scopeBreakdown.viewLevel', { level: cap(childLevel) })}
            <svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' strokeWidth='2.5'>
              <path d='M9 6l6 6-6 6' strokeLinecap='round' strokeLinejoin='round' />
            </svg>
          </Link>
        </div>
      )}
    </div>
  )
}

// ─── Expanded stat row (inside accordion) ────────────────────────────────────

const EXPANDED_ICONS = {
  present: (
    <svg viewBox='0 0 24 24' width='18' height='18' fill='none' stroke='currentColor' strokeWidth='2.2' strokeLinecap='round' strokeLinejoin='round'>
      <path d='M20 6L9 17l-5-5' />
    </svg>
  ),
  absent: (
    <svg viewBox='0 0 24 24' width='18' height='18' fill='none' stroke='currentColor' strokeWidth='2.2' strokeLinecap='round' strokeLinejoin='round'>
      <path d='M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z' />
      <line x1='12' y1='9' x2='12' y2='13' /><line x1='12' y1='17' x2='12.01' y2='17' />
    </svg>
  ),
}

function ExpandedStatRow({ icon, label, count, to }: { icon: 'present' | 'absent'; label: string; count: number; to?: string }) {
  const iconBg   = icon === 'present' ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive'
  const countClr = icon === 'present' ? 'text-success' : 'text-destructive'
  const inner = (
    <>
      <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', iconBg)}>
        {EXPANDED_ICONS[icon]}
      </div>
      <span className='flex-1 text-sm font-semibold text-foreground'>{label}</span>
      <span className={cn('tnum text-lg font-bold', countClr)}>{count}</span>
      {to && (
        <svg viewBox='0 0 24 24' width='14' height='14' className='shrink-0 text-muted-foreground/40' fill='none' stroke='currentColor' strokeWidth='2'>
          <path d='M9 6l6 6-6 6' strokeLinecap='round' strokeLinejoin='round' />
        </svg>
      )}
    </>
  )
  if (to) {
    return (
      <Link to={to} className='flex items-center gap-3 px-4 py-3 no-underline transition-colors active:bg-muted/50'>
        {inner}
      </Link>
    )
  }
  return <div className='flex items-center gap-3 px-4 py-3'>{inner}</div>
}

// ─── MemberRow ────────────────────────────────────────────────────────────────

function MemberRow({ member: m, record: r, status }: { member: any; record: any; status: string }) {
  const { t } = useTranslation()
  const name = [m.first_name, m.last_name].filter(Boolean).join(' ') || m.id
  const unit = m.bacenta_name || m.governorship_name || m.council_name || (m.roles || [])[0] || '—'
  const initials = [(m.first_name || '')[0], (m.last_name || '')[0]].filter(Boolean).join('').toUpperCase() || '?'
  const statusLabel = status === 'Present' ? t('common.present') : t('common.absent')
  const statusClass = status === 'Present' ? 'text-success' : 'text-destructive'

  return (
    <div className='flex items-center gap-3 overflow-hidden rounded-2xl border border-border bg-card px-4 py-3.5'>
      {m.picture_url ? (
        <img src={m.picture_url} alt={name} className='h-12 w-12 shrink-0 rounded-full object-cover' />
      ) : (
        <div className='flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-bold text-muted-foreground'>
          {initials}
        </div>
      )}
      <div className='min-w-0 flex-1'>
        <p className='m-0 truncate text-sm font-semibold text-foreground'>{name}</p>
        <p className='m-0 mt-0.5 truncate text-xs text-muted-foreground'>{unit}</p>
      </div>
      <div className='shrink-0 text-right'>
        <p className={cn('m-0 text-xs font-bold', statusClass)}>{statusLabel}</p>
        {r?.checked_in_at && (
          <p className='m-0 mt-0.5 text-[11px] text-muted-foreground'>{format(new Date(r.checked_in_at), 'HH:mm')}</p>
        )}
      </div>
    </div>
  )
}

function cap(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}
