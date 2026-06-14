import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import Spinner from '../Spinner'
import { format } from 'date-fns'
import ScreenHeader from '../ScreenHeader'
import { PageShell, PageMain } from '../layout/PageShell'
import { CenterCard } from '../layout/CenterCard'
import { cn } from '../../lib/utils'
import {
  getEvent, listCheckedIn, bulkUpsertMemberProfiles,
} from '../../utils/supabaseCheckins'
import {
  getMembersInScope, memberToProfileRow,
  resolveCurrentMember, getChurchAncestors, getViewerCapabilities,
  childScopeLevel, getChildChurches,
} from '../../utils/membersApi'
import { getCurrentUser, SCOPE_LEVELS } from '../../utils/auth'
import { useRefreshSignal } from '../../hooks/useRefreshSignal'

export default function ScopeBreakdown({ eventId }) {
  const user = getCurrentUser()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const drillLevel    = searchParams.get('level')      || null
  const drillChurchId = searchParams.get('churchId')   || null
  const drillChurchName = searchParams.get('churchName') || null

  const [event, setEvent]           = useState<any>(null)
  const [allEligible, setAllEligible] = useState<any[]>([])
  const [childChurches, setChildChurches] = useState<{ id: string; name: string }[] | null>(null)
  const [records, setRecords]       = useState<any[]>([])
  const [error, setError]           = useState<string | null>(null)
  const [viewerCaps, setViewerCaps] = useState<any>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  useRefreshSignal(() => setRefreshKey((k) => k + 1))

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const evt = await getEvent(eventId)
        if (cancelled) return
        setEvent(evt)

        const [viewer, ancestors, eventScopeMembers, recs] = await Promise.all([
          resolveCurrentMember(user).catch(() => null),
          getChurchAncestors({ level: evt.scope_level, id: evt.scope_church_id }).catch(() => []),
          getMembersInScope({ level: evt.scope_level, churchId: evt.scope_church_id }),
          listCheckedIn(eventId),
        ])
        if (cancelled) return

        const allRows = eventScopeMembers.map(memberToProfileRow)
        await bulkUpsertMemberProfiles(allRows)
        const allowed = new Set(evt.allowed_roles || [])
        const eligibleRows = allRows.filter((r) => (r.roles || []).some((rr) => allowed.has(rr)))
        const eligibleIdSet = new Set(eligibleRows.map((r) => r.id))
        const allMemberIdSet = new Set(allRows.map((r) => r.id))
        const rawCaps = getViewerCapabilities(viewer, evt, ancestors, eligibleIdSet, allMemberIdSet)
        const eventScope = {
          level: evt.scope_level, id: evt.scope_church_id, name: evt.scope_church_name,
        }
        const scopeFallback = rawCaps.canViewFullEvent ? eventScope : (rawCaps.viewerScope ?? eventScope)
        const caps = user?.isSuperAdmin
          ? { ...rawCaps, canManage: true, canCheckIn: true, canView: true, canViewFullEvent: true, canManuallyCheckIn: true, viewerScope: eventScope }
          : user?.isSuperViewer
          ? { ...rawCaps, canManage: false, canCheckIn: false, canView: true, canViewFullEvent: true, canManuallyCheckIn: false, viewerScope: eventScope }
          : rawCaps.canViewFullEvent
          ? { ...rawCaps, viewerScope: scopeFallback }
          : rawCaps
        if (cancelled) return
        setViewerCaps(caps)
        setAllEligible(eligibleRows)
        setRecords(recs)
      } catch (err: any) {
        if (!cancelled) setError(err.message)
      }
    })()
    return () => { cancelled = true }
  }, [eventId, user.userId, refreshKey]) // eslint-disable-line

  const viewerScopeIdx  = viewerCaps?.viewerScope ? SCOPE_LEVELS.indexOf(viewerCaps.viewerScope.level) : -1
  const requestedLevel  = drillLevel || event?.scope_level
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
    return () => { cancelled = true }
  }, [currentLevel, currentChurchId])

  const sliceRows = useMemo(() => {
    if (!currentLevel || !currentChurchId) return allEligible
    const idCol = `${currentLevel}_id`
    return allEligible.filter((m) => m[idCol] === currentChurchId)
  }, [allEligible, currentLevel, currentChurchId])

  const childLevel = currentLevel ? childScopeLevel(currentLevel) : null

  const { groups, unassignedRows } = useMemo(() => {
    if (!childLevel) return { groups: [], unassignedRows: [] }
    const idCol   = `${childLevel}_id`
    const nameCol = `${childLevel}_name`
    const recordByMember = new Map(records.map((r) => [r.member_id, r]))

    type GroupStats = {
      id: string; name: string
      total: number; attended: number; stillIn: number; left: number; absent: number
    }
    const blank = (id: string, name: string): GroupStats => ({ id, name, total: 0, attended: 0, stillIn: 0, left: 0, absent: 0 })

    const map = new Map<string, GroupStats>()
    if (childChurches) {
      for (const c of childChurches) map.set(c.id, blank(c.id, c.name))
    }

    const unassigned: { member: any; record: any; status: string }[] = []
    for (const m of sliceRows) {
      const key = m[idCol]
      if (!key) {
        const rec = recordByMember.get(m.id) || null
        const status = !rec ? 'Defaulted' : rec.checked_out_at ? 'Checked Out' : 'Checked In'
        unassigned.push({ member: m, record: rec, status })
        continue
      }
      const name = m[nameCol] || key
      if (!map.has(key)) map.set(key, blank(key, name))
      const g = map.get(key)!
      g.total++
      const rec = recordByMember.get(m.id)
      const notStarted = !!event?.starts_at && new Date(event.starts_at) > new Date()
      if (rec) { g.attended++; if (rec.checked_out_at) g.left++; else g.stillIn++ }
      else if (!notStarted) g.absent++
    }
    const statusOrder = { 'Checked In': 0, 'Checked Out': 1, 'Defaulted': 2 }
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
      const status = !r ? 'Defaulted' : r.checked_out_at ? 'Checked Out' : 'Checked In'
      return { member: m, record: r, status }
    }).sort((a, b) => {
      const order = { 'Checked In': 0, 'Checked Out': 1, 'Defaulted': 2 }
      return (order[a.status] ?? 3) - (order[b.status] ?? 3)
    })
  }, [sliceRows, currentLevel, childLevel, records])

  const backTo = drillLevel ? null : `/events/${eventId}`
  const isMemberList = currentLevel === 'governorship' || childLevel === null || childLevel === 'bacenta'

  if (error) return <CenterCard><p className='text-destructive'>{error}</p></CenterCard>
  if (!event || !viewerCaps) return <Spinner fullPage />
  if (!viewerCaps.canManage && !viewerCaps.canCheckIn && !viewerCaps.canView) {
    return <CenterCard><p className='text-muted-foreground'>This event isn&apos;t part of your scope.</p></CenterCard>
  }

  return (
    <PageShell>
      <ScreenHeader
        title={currentName || 'Breakdown'}
        back={backTo ? { to: backTo, label: 'Dashboard' } : undefined}
        onBack={!backTo ? () => navigate(-1) : undefined}
      />
      <PageMain className='flex flex-col gap-3 py-5'>
        <div className='flex items-center justify-between'>
          <p className='eyebrow m-0'>
            {isMemberList
              ? `${sliceRows.length} member${sliceRows.length !== 1 ? 's' : ''}`
              : `${groups.length} ${cap(childLevel!)}${groups.length !== 1 ? 's' : ''}${unassignedRows.length > 0 ? ` · +${unassignedRows.length} at this level` : ''}`}
          </p>
          {!isMemberList && (
            <Link
              to={`/events/${eventId}/members?status=all&level=${currentLevel}&churchId=${currentChurchId}&churchName=${encodeURIComponent(currentName)}`}
              className='text-xs text-primary underline'
            >
              All members ↗
            </Link>
          )}
        </div>

        {/* ── Scope accordion list ── */}
        {!isMemberList && (
          <div className='flex flex-col gap-3'>
            {groups.map((g) => (
              <ScopeCard
                key={g.id}
                group={g}
                childLevel={childLevel!}
                eventId={eventId}
                isExpanded={expandedId === g.id}
                onToggle={() => setExpandedId(expandedId === g.id ? null : g.id)}
                sliceRows={sliceRows}
              />
            ))}
          </div>
        )}

        {/* ── Unassigned members (scope-level leaders with no child scope) ── */}
        {!isMemberList && unassignedRows.length > 0 && (
          <>
            <p className='mt-1 text-xs font-semibold text-muted-foreground'>
              {cap(currentLevel!)} level · {unassignedRows.length} member{unassignedRows.length !== 1 ? 's' : ''}
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
          <p className='mt-4 text-center text-sm text-muted-foreground'>No eligible members in this scope.</p>
        )}
        {isMemberList && memberRows.length > 0 && (
          <div className='flex flex-col gap-2'>
            {memberRows.map(({ member: m, record: r, status }) => (
              <MemberRow key={m.id} member={m} record={r} status={status} />
            ))}
          </div>
        )}
      </PageMain>
    </PageShell>
  )
}

// ─── Leader lookup ────────────────────────────────────────────────────────────

function getLeaderForScope(sliceRows: any[], childLevel: string, scopeId: string) {
  const idCol = `${childLevel}_id`
  const roleKey = `leader${childLevel.charAt(0).toUpperCase()}${childLevel.slice(1)}`
  const inScope = sliceRows.filter((m) => m[idCol] === scopeId)
  return inScope.find((m) => (m.roles || []).includes(roleKey)) || inScope[0] || null
}

// ─── ScopeCard (accordion item) ──────────────────────────────────────────────

function ScopeCard({
  group, childLevel, eventId, isExpanded, onToggle, sliceRows,
}: {
  group: { id: string; name: string; total: number; attended: number; absent: number }
  childLevel: string
  eventId: string
  isExpanded: boolean
  onToggle: () => void
  sliceRows: any[]
}) {
  const leader = getLeaderForScope(sliceRows, childLevel, group.id)
  const leaderName = leader
    ? [leader.first_name, leader.last_name].filter(Boolean).join(' ')
    : ''
  const initials = leaderName
    ? leaderName.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase()
    : group.name.charAt(0).toUpperCase()

  const drillPath = `/events/${eventId}?scopeLevel=${childLevel}&scopeChurchId=${group.id}&scopeChurchName=${encodeURIComponent(group.name)}`
  const membersBase = `/events/${eventId}/members`
  const scopeQ = `level=${childLevel}&churchId=${group.id}&churchName=${encodeURIComponent(group.name)}`
  const presentLink = `${membersBase}?status=present&${scopeQ}`
  const absentLink  = `${membersBase}?status=absent&${scopeQ}`
  const allLink     = `${membersBase}?status=all&${scopeQ}`

  return (
    <div className='overflow-hidden rounded-2xl border border-border bg-card'>
      {/* ── Row header ── */}
      <button
        type='button'
        onClick={onToggle}
        className='flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-muted/40'
      >
        {leader?.picture_url ? (
          <img src={leader.picture_url} alt={leaderName} className='h-12 w-12 shrink-0 rounded-full object-cover' />
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
          <span className='tnum text-sm font-bold text-foreground'>{group.total}</span>
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
            <ExpandedStatRow icon='present' label='Leaders Checked In' count={group.attended} to={presentLink} />
            <div className='h-px bg-border' />
            <ExpandedStatRow icon='absent'  label='Leaders Absent'     count={group.absent}   to={absentLink} />
            <div className='h-px bg-border' />
            <ExpandedStatRow icon='primary' label='Total Expected'     count={group.total}    to={allLink} />
          </div>
          <Link
            to={drillPath}
            className='mt-3 flex items-center justify-end gap-1 text-sm font-semibold text-primary no-underline'
          >
            View {cap(childLevel)}
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
  primary: (
    <svg viewBox='0 0 24 24' width='18' height='18' fill='none' stroke='currentColor' strokeWidth='2.2' strokeLinecap='round' strokeLinejoin='round'>
      <path d='M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' /><circle cx='9' cy='7' r='4' />
      <path d='M23 21v-2a4 4 0 0 0-3-3.87' /><path d='M16 3.13a4 4 0 0 1 0 7.75' />
    </svg>
  ),
}

function ExpandedStatRow({ icon, label, count, to }: { icon: 'present' | 'absent' | 'primary'; label: string; count: number; to?: string }) {
  const iconBg   = icon === 'present' ? 'bg-success/15 text-success'     : icon === 'absent' ? 'bg-destructive/15 text-destructive' : 'bg-primary/15 text-primary'
  const countClr = icon === 'present' ? 'text-success' : icon === 'absent' ? 'text-destructive' : 'text-foreground'
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
  const name = [m.first_name, m.last_name].filter(Boolean).join(' ') || m.id
  const unit = m.bacenta_name || m.governorship_name || m.council_name || (m.roles || [])[0] || '—'
  const initials = [(m.first_name || '')[0], (m.last_name || '')[0]].filter(Boolean).join('').toUpperCase() || '?'
  const statusClass = status === 'Checked In' ? 'text-success' : status === 'Checked Out' ? 'text-warning' : 'text-destructive'

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
        <p className={cn('m-0 text-xs font-bold', statusClass)}>{status}</p>
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
