import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { format } from 'date-fns'
import ScreenHeader from '../ScreenHeader'
import {
  getEvent, listCheckedIn, bulkUpsertMemberProfiles,
} from '../../utils/supabaseCheckins'
import {
  getMembersInScope, memberToProfileRow,
  resolveCurrentMember, getChurchAncestors, getViewerCapabilities,
  childScopeLevel, getChildChurches,
} from '../../utils/membersApi'
import { getCurrentUser, SCOPE_LEVELS } from '../../utils/auth'

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

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const evt = await getEvent(eventId)
        if (cancelled) return
        setEvent(evt)

        const [viewer, ancestors, eventScopeMembers, recs] = await Promise.all([
          resolveCurrentMember(user),
          getChurchAncestors({ level: evt.scope_level, id: evt.scope_church_id }),
          getMembersInScope({ level: evt.scope_level, churchId: evt.scope_church_id }),
          listCheckedIn(eventId),
        ])
        if (cancelled) return

        const allRows = eventScopeMembers.map(memberToProfileRow)
        await bulkUpsertMemberProfiles(allRows)
        const allowed = new Set(evt.allowed_roles || [])
        const eligibleRows = allRows.filter((r) => (r.roles || []).some((rr) => allowed.has(rr)))
        const eligibleIdSet = new Set(eligibleRows.map((r) => r.id))
        const caps = getViewerCapabilities(viewer, evt, ancestors, eligibleIdSet)
        if (cancelled) return
        setViewerCaps(caps)
        setAllEligible(eligibleRows)
        setRecords(recs)
      } catch (err: any) {
        if (!cancelled) setError(err.message)
      }
    })()
    return () => { cancelled = true }
  }, [eventId, user.userId]) // eslint-disable-line

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
  const { groups, unassignedCount } = useMemo(() => {
    if (!childLevel) return { groups: [], unassignedCount: 0 }
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

    let unassigned = 0
    for (const m of sliceRows) {
      const key = m[idCol]
      if (!key) { unassigned++; continue }
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
    return {
      groups: [...map.values()].sort((a, b) => b.total - a.total),
      unassignedCount: unassigned,
    }
  }, [sliceRows, childLevel, records])

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

  if (error) return <CenterCard><p style={{ color: 'var(--coral)' }}>{error}</p></CenterCard>
  if (!event || !viewerCaps) return <CenterCard><p style={{ color: 'var(--muted)' }}>Loading…</p></CenterCard>
  if (!viewerCaps.canManage && !viewerCaps.canCheckIn && !viewerCaps.canView) {
    return <CenterCard><p style={{ color: 'var(--muted)' }}>This event isn't part of your scope.</p></CenterCard>
  }

  const isMemberList = currentLevel === 'governorship' || childLevel === null || childLevel === 'bacenta'

  return (
    <div className='min-h-dvh' style={{ background: 'var(--bg)' }}>
      <ScreenHeader
        title={currentName || 'Breakdown'}
        back={backTo
          ? { to: backTo, label: 'Dashboard' }
          : undefined}
        onBack={!backTo ? () => navigate(-1) : undefined}
      />

      <main className='max-w-5xl mx-auto px-4 sm:px-6 py-5 flex flex-col gap-3'>
        {/* Breadcrumb-like context */}
        <div className='flex items-center justify-between'>
          <p className='eyebrow m-0'>
            {isMemberList
              ? `${sliceRows.length} member${sliceRows.length !== 1 ? 's' : ''}`
              : `${groups.length} ${cap(childLevel!)}${groups.length !== 1 ? 's' : ''}${unassignedCount > 0 ? ` · +${unassignedCount} unassigned` : ''}`}
          </p>
          {!isMemberList && (
            <Link
              to={`/events/${eventId}/report?level=${currentLevel}&churchId=${currentChurchId}&churchName=${encodeURIComponent(currentName)}`}
              className='text-xs underline'
              style={{ color: 'var(--accent)' }}
            >
              Full report ↗
            </Link>
          )}
        </div>

        {/* ── Child-scope group cards ── */}
        {!isMemberList && unassignedCount > 0 && (
          <p className='text-xs' style={{ color: 'var(--muted)' }}>
            {unassignedCount} leader{unassignedCount !== 1 ? 's' : ''} at this level (not counted in {cap(childLevel!)} totals)
          </p>
        )}
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
                  className='block p-4 transition-opacity hover:opacity-90 active:scale-[0.99]'
                  style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-card)', textDecoration: 'none', boxShadow: 'var(--shadow-1)' }}
                >
                  <div className='flex items-center justify-between gap-3 mb-2'>
                    <p className='text-sm font-semibold m-0 truncate' style={{ color: 'var(--text)' }}>{g.name}</p>
                    <span className='text-xs font-bold' style={{ color: pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--amber)' : 'var(--coral)' }}>{pct}%</span>
                  </div>
                  <div className='h-1.5 overflow-hidden mb-3' style={{ background: 'var(--bg2)', borderRadius: 'var(--radius-pill)' }}>
                    <div className='h-full' style={{ width: `${pct}%`, background: pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--amber)' : 'var(--coral)', borderRadius: 'var(--radius-pill)' }} />
                  </div>
                  <div className='flex gap-4'>
                    <SmallStat value={g.stillIn} label='Still In' color='var(--green)' />
                    <SmallStat value={g.left}    label='Left'     color='var(--amber)' />
                    <SmallStat value={g.absent}  label='Absent'   color='var(--coral)' />
                    <SmallStat value={g.total}   label='Total' />
                  </div>
                </Link>
              )
            })}
          </div>
        )}

        {/* ── Member list (at governorship / bottom of drill) ── */}
        {isMemberList && memberRows.length === 0 && (
          <p className='text-sm text-center mt-4' style={{ color: 'var(--muted)' }}>No eligible members in this scope.</p>
        )}
        {isMemberList && memberRows.length > 0 && (
          <div className='grid grid-cols-1 md:grid-cols-2 gap-2'>
            {memberRows.map(({ member: m, record: r, status }) => {
              const name = [m.first_name, m.last_name].filter(Boolean).join(' ') || m.id
              const statusColor = status === 'Checked In' ? 'var(--green)' : status === 'Checked Out' ? 'var(--amber)' : 'var(--coral)'
              return (
                <div
                  key={m.id}
                  className='px-4 py-3 flex items-center justify-between gap-3'
                  style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-btn)' }}
                >
                  <div className='min-w-0'>
                    <p className='text-sm font-semibold m-0 truncate' style={{ color: 'var(--text)' }}>{name}</p>
                    <p className='text-xs m-0 mt-0.5' style={{ color: 'var(--muted)' }}>{(m.roles || [])[0] || '—'}</p>
                  </div>
                  <div className='text-right shrink-0'>
                    <p className='text-xs font-bold m-0' style={{ color: statusColor }}>{status}</p>
                    {r?.checked_in_at && (
                      <p className='text-xs m-0 mt-0.5' style={{ color: 'var(--muted)' }}>{format(new Date(r.checked_in_at), 'HH:mm')}</p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}

function cap(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

function SmallStat({ value, label, color = 'var(--text)' }: { value: number; label: string; color?: string }) {
  return (
    <div className='text-center'>
      <p className='text-sm font-bold m-0' style={{ color }}>{value}</p>
      <p className='text-[10px] m-0' style={{ color: 'var(--muted)' }}>{label}</p>
    </div>
  )
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
