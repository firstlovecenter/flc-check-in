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

// ─── ScopeBreakdown ──────────────────────────────────────────────────────────
// Drills down from the event scope all the way to individual member lists.
//
// URL params:
//   ?level=council&churchId=abc   → view this scope (defaults to event scope)
//
// At each level we group members by the level immediately below.
// At bacenta level (bottom), we show the individual member list.
// ─────────────────────────────────────────────────────────────────────────────
export default function ScopeBreakdown({ eventId }) {
  const user = getCurrentUser()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  // The scope we're currently viewing (default = event scope)
  const drillLevel   = searchParams.get('level')   || null
  const drillChurchId = searchParams.get('churchId') || null
  const drillChurchName = searchParams.get('churchName') || null

  const [event, setEvent] = useState<any>(null)
  const [allEligible, setAllEligible] = useState<any[]>([])  // full event scope eligible
  const [childChurches, setChildChurches] = useState<{ id: string; name: string }[] | null>(null)
  const [records, setRecords] = useState<any[]>([])
  const [error, setError] = useState<string | null>(null)
  const [viewerCaps, setViewerCaps] = useState<any>(null)
  const [refreshKey, setRefreshKey] = useState(0)
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
        const eligibleRows = user?.isSuperAdmin
          ? allRows
          : allRows.filter((r) => (r.roles || []).some((rr) => allowed.has(rr)))
        const eligibleIdSet = new Set(eligibleRows.map((r) => r.id))
        const rawCaps = getViewerCapabilities(viewer, evt, ancestors, eligibleIdSet)
        // superAdmin bypass: getViewerCapabilities only checks the member graph
        // hierarchy and deliberately leaves this to callers (see membersApi.ts).
        const caps = user?.isSuperAdmin
          ? {
              ...rawCaps,
              canManage: true,
              canCheckIn: true,
              canView: true,
              canManuallyCheckIn: true,
              viewerScope: rawCaps.viewerScope ?? {
                level: evt.scope_level,
                id: evt.scope_church_id,
                name: evt.scope_church_name,
              },
            }
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

  // The current scope we're showing.
  // For non-admin leaders, clamp to their own scope if the URL/default points above it.
  const viewerScopeIdx = viewerCaps?.viewerScope ? SCOPE_LEVELS.indexOf(viewerCaps.viewerScope.level) : -1
  const requestedLevel  = drillLevel || event?.scope_level
  const requestedIdx    = requestedLevel ? SCOPE_LEVELS.indexOf(requestedLevel) : -1
  const shouldClamp     = !viewerCaps?.canManage && viewerScopeIdx >= 0 && requestedIdx > viewerScopeIdx

  const currentLevel    = shouldClamp ? viewerCaps!.viewerScope!.level : requestedLevel
  const currentChurchId = shouldClamp ? viewerCaps!.viewerScope!.id    : (drillChurchId || event?.scope_church_id)
  const currentName     = shouldClamp ? viewerCaps!.viewerScope!.name  : (drillChurchName || event?.scope_church_name || '')

  // Whenever we navigate to a new drill level, load its direct children from
  // the graph so empty scopes (no eligible members) still appear as cards.
  useEffect(() => {
    if (!currentLevel || !currentChurchId) return
    let cancelled = false
    getChildChurches({ level: currentLevel, id: currentChurchId })
      .then((list) => { if (!cancelled) setChildChurches(list) })
      .catch(() => { if (!cancelled) setChildChurches([]) })
    return () => { cancelled = true }
  }, [currentLevel, currentChurchId])

  // Filter eligible members to the current scope's church
  const sliceRows = useMemo(() => {
    if (!currentLevel || !currentChurchId) return allEligible
    const idCol = `${currentLevel}_id`
    return allEligible.filter((m) => m[idCol] === currentChurchId)
  }, [allEligible, currentLevel, currentChurchId])

  // The level directly below currentLevel
  const childLevel = currentLevel ? childScopeLevel(currentLevel) : null

  // Group sliceRows by childLevel, anchored to the real child church list so
  // empty child scopes (no eligible members) still appear.
  // Stats model matches EventDashboard:
  //   attended = stillIn + left  (anyone who has a record)
  //   absent   = members with no record at all
  const { groups, unassignedRows } = useMemo(() => {
    if (!childLevel) return { groups: [], unassignedRows: [] }
    const idCol   = `${childLevel}_id`
    const nameCol = `${childLevel}_name`
    const recordByMember = new Map(records.map((r) => [r.member_id, r]))

    type GroupStats = {
      id: string
      name: string
      total: number
      attended: number
      stillIn: number
      left: number
      absent: number
    }
    const blank = (id: string, name: string): GroupStats => ({
      id, name, total: 0, attended: 0, stillIn: 0, left: 0, absent: 0,
    })

    // Seed map from graph child list (authoritative) so every child church
    // has a card, even if it has 0 eligible members.
    const map = new Map<string, GroupStats>()
    if (childChurches) {
      for (const c of childChurches) {
        map.set(c.id, blank(c.id, c.name))
      }
    }

    // Members with no child-scope assignment (e.g. council leaders in a
    // council-level event have no governorship_id). Collect as rows so they
    // can be rendered in-line rather than just counted.
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
      if (rec) {
        g.attended++
        if (rec.checked_out_at) g.left++
        else g.stillIn++
      } else {
        g.absent++
      }
    }
    const statusOrder = { 'Checked In': 0, 'Checked Out': 1, 'Defaulted': 2 }
    return {
      groups: [...map.values()].sort((a, b) => b.total - a.total),
      unassignedRows: unassigned.sort((a, b) => (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3)),
    }
  }, [sliceRows, childLevel, records, childChurches])

  // At governorship level show individual members (governorship is the lowest
  // meaningful drill unit — bacentas are not reported on).
  const memberRows = useMemo(() => {
    if (currentLevel !== 'governorship' && childLevel !== null && childLevel !== 'bacenta') return []
    const recordByMember = new Map(records.map((r) => [r.member_id, r]))
    return sliceRows.map((m) => {
      const r = recordByMember.get(m.id) || null
      let status: string
      if (!r) status = 'Defaulted'
      else if (r.checked_out_at) status = 'Checked Out'
      else status = 'Checked In'
      return { member: m, record: r, status }
    }).sort((a, b) => {
      const order = { 'Checked In': 0, 'Checked Out': 1, 'Defaulted': 2 }
      return (order[a.status] ?? 3) - (order[b.status] ?? 3)
    })
  }, [sliceRows, currentLevel, childLevel, records])

  const backTo = drillLevel
    ? null // handled by browser back
    : `/events/${eventId}`

  if (error) {
    return (
      <CenterCard><p className='text-destructive'>{error}</p></CenterCard>
    )
  }
  if (!event || !viewerCaps) return <Spinner fullPage />
  if (!viewerCaps.canManage && !viewerCaps.canCheckIn && !viewerCaps.canView) {
    return (
      <CenterCard><p className='text-muted-foreground'>This event isn&apos;t part of your scope.</p></CenterCard>
    )
  }

  const isMemberList = currentLevel === 'governorship' || childLevel === null || childLevel === 'bacenta'

  return (
    <PageShell>
      <ScreenHeader
        title={currentName || 'Breakdown'}
        back={backTo ? { to: backTo, label: 'Dashboard' } : undefined}
        onBack={!backTo ? () => navigate(-1) : undefined}
      />
      <PageMain className='flex flex-col gap-3 py-5'>
        {/* Breadcrumb-like context */}
        <div className='flex items-center justify-between'>
          <p className='eyebrow m-0'>
            {isMemberList
              ? `${sliceRows.length} member${sliceRows.length !== 1 ? 's' : ''}`
              : `${groups.length} ${cap(childLevel!)}${groups.length !== 1 ? 's' : ''}${unassignedRows.length > 0 ? ` · +${unassignedRows.length} at this level` : ''}`}
          </p>
          {!isMemberList && (
            <Link
              to={`/events/${eventId}/report?level=${currentLevel}&churchId=${currentChurchId}&churchName=${encodeURIComponent(currentName)}`}
              className='text-xs underline text-primary'
            >
              Full report ↗
            </Link>
          )}
        </div>

        {/* ── Child-scope group cards ── */}
        {!isMemberList && (
          <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3'>
            {groups.map((g) => {
              const pct = g.total > 0 ? Math.round((g.attended / g.total) * 100) : 0
              // Navigate to a scoped EventDashboard for this child church.
              const drillPath = `/events/${eventId}?scopeLevel=${childLevel}&scopeChurchId=${g.id}&scopeChurchName=${encodeURIComponent(g.name)}`
              return (
                <Link
                  key={g.id}
                  to={drillPath}
                  className='stat-link-card block p-4 no-underline transition-opacity hover:opacity-90 active:scale-[0.99]'
                >
                  <div className='mb-2 flex items-center justify-between gap-3'>
                    <p className='m-0 truncate text-sm font-semibold text-foreground'>{g.name}</p>
                    <span
                      className={cn(
                        'text-xs font-bold',
                        pct >= 80 ? 'text-success' : pct >= 50 ? 'text-warning' : 'text-destructive',
                      )}
                    >
                      {pct}%
                    </span>
                  </div>
                  <div className='mb-3 h-1.5 overflow-hidden rounded-full bg-secondary'>
                    <div
                      className={cn(
                        'h-full rounded-full',
                        pct >= 80 ? 'bg-success' : pct >= 50 ? 'bg-warning' : 'bg-destructive',
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className='flex gap-4'>
                    <SmallStat value={g.stillIn} label='Still In' tone='success' />
                    <SmallStat value={g.left} label='Left' tone='warning' />
                    <SmallStat value={g.absent} label='Absent' tone='destructive' />
                    <SmallStat value={g.total} label='Total' />
                  </div>
                </Link>
              )
            })}
          </div>
        )}

        {/* ── Members with no child-scope assignment (e.g. council leaders in a
             council-level event who have no single governorship) ── */}
        {!isMemberList && unassignedRows.length > 0 && (
          <>
            <p className='text-xs font-semibold mt-1 text-muted-foreground'>
              {cap(currentLevel!)} level · {unassignedRows.length} member{unassignedRows.length !== 1 ? 's' : ''}
            </p>
            <div className='grid grid-cols-1 md:grid-cols-2 gap-2'>
              {unassignedRows.map(({ member: m, record: r, status }) => (
                <MemberRow key={m.id} member={m} record={r} status={status} />
              ))}
            </div>
          </>
        )}

        {/* ── Member list (at governorship / bottom of drill) ── */}
        {isMemberList && memberRows.length === 0 && (
          <p className='text-sm text-center mt-4 text-muted-foreground'>No eligible members in this scope.</p>
        )}
        {isMemberList && memberRows.length > 0 && (
          <div className='grid grid-cols-1 md:grid-cols-2 gap-2'>
            {memberRows.map(({ member: m, record: r, status }) => (
              <MemberRow key={m.id} member={m} record={r} status={status} />
            ))}
          </div>
        )}
      </PageMain>
    </PageShell>
  )
}

function MemberRow({ member: m, record: r, status }: { member: any; record: any; status: string }) {
  const name = [m.first_name, m.last_name].filter(Boolean).join(' ') || m.id
  const statusClass =
    status === 'Checked In'
      ? 'text-success'
      : status === 'Checked Out'
        ? 'text-warning'
        : 'text-destructive'
  return (
    <div className='list-row surface-card flex items-center justify-between gap-3 rounded-lg px-4 py-3'>
      <div className='min-w-0'>
        <p className='m-0 truncate text-sm font-semibold text-foreground'>{name}</p>
        <p className='m-0 mt-0.5 text-xs text-muted-foreground'>{(m.roles || [])[0] || '—'}</p>
      </div>
      <div className='shrink-0 text-right'>
        <p className={cn('m-0 text-xs font-bold', statusClass)}>{status}</p>
        {r?.checked_in_at && (
          <p className='text-xs m-0 mt-0.5 text-muted-foreground'>{format(new Date(r.checked_in_at), 'HH:mm')}</p>
        )}
      </div>
    </div>
  )
}

function cap(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

function SmallStat({
  value,
  label,
  tone,
}: {
  value: number
  label: string
  tone?: 'success' | 'warning' | 'destructive'
}) {
  return (
    <div className='text-center'>
      <p
        className={cn(
          'm-0 text-sm font-bold',
          tone === 'success' && 'text-success',
          tone === 'warning' && 'text-warning',
          tone === 'destructive' && 'text-destructive',
          !tone && 'text-foreground',
        )}
      >
        {value}
      </p>
      <p className='m-0 text-[10px] text-muted-foreground'>{label}</p>
    </div>
  )
}
