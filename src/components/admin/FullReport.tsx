import { memo, useCallback, useEffect, useMemo, useState, useDeferredValue, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Skeleton, SkeletonRows } from '../ui/skeleton'
import { toast } from '../Toast'
import { format } from 'date-fns'
import Papa from 'papaparse'
import ScreenHeader from '../ScreenHeader'
import ManualCheckInModal from './ManualCheckInModal'
import { PageShell, PageMain } from '../layout/PageShell'
import { CenterCard } from '../layout/CenterCard'
import { Card, CardContent } from '../ui/card'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { Label } from '../ui/label'
import { Select } from '../ui/select'
import { Textarea } from '../ui/textarea'
import { Modal } from '../ui/modal'
import { cn } from '../../lib/utils'
import {
  listCheckedIn,
  listAbsenceNotesForEvent, upsertAbsenceNote, addAuditLog, getRiskyCheckIns,
} from '../../utils/supabaseCheckins'
import { childScopeLevel } from '../../utils/membersApi'
import { getCurrentUser, formatName } from '../../utils/auth'
import { useEventEligibility } from '../../hooks/useEventEligibility'
import { useRefreshSignal } from '../../hooks/useRefreshSignal'
import { PaginationControls, useClientPagination } from '../PaginationControls'

// Only two attendance statuses exist: Present (has a record) and Absent.
// Tab ids stay stable so old ?tab= URLs keep working.
const TABS = [
  { id: 'checked-in', label: 'Present' },
  { id: 'defaulted', label: 'Absent' },
  { id: 'timeline', label: 'Timeline' },
] as const

const NAMES_PAGE_SIZE = 50
const TIMELINE_PAGE_SIZE = 50

type TabId = (typeof TABS)[number]['id']

/** Drop null/blank rows from snapshots — prevents `null.id` crashes in memos. */
function membersWithId(list: any[] | null | undefined): any[] {
  return (list || []).filter((m) => m != null && m.id != null && m.id !== '')
}

export default function FullReport({ eventId }: { eventId: string }) {
  const user = getCurrentUser()
  const [params, setParams] = useSearchParams()
  const activeTab = (TABS.find((t) => t.id === params.get('tab'))?.id || 'checked-in') as TabId

  const urlLevel = params.get('level') || null
  const urlChurchId = params.get('churchId') || null
  const urlChurchName = params.get('churchName') || null

  const [refreshKey, setRefreshKey] = useState(0)
  useRefreshSignal(() => setRefreshKey((k) => k + 1))

  const {
    event, eligible: allEligible, viewerSlice, viewerCaps, records,
    error: eligibilityError, initialLoading, setRecords,
  } = useEventEligibility(eventId, user, { refreshKey })

  const safeAllEligible = useMemo(() => membersWithId(allEligible), [allEligible])
  const safeViewerSlice = useMemo(() => membersWithId(viewerSlice), [viewerSlice])

  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [modalMember, setModalMember] = useState<any>(null)
  const [absenceNotes, setAbsenceNotes] = useState<Map<string, string>>(new Map())
  const [absenceTarget, setAbsenceTarget] = useState<any | null>(null)
  const [absenceInput, setAbsenceInput] = useState('')
  const [absenceSaving, setAbsenceSaving] = useState(false)

  const [riskyIds, setRiskyIds] = useState<Set<string>>(new Set())

  const displayError = error || eligibilityError

  useEffect(() => {
    if (!eventId) return
    listAbsenceNotesForEvent(eventId)
      .then(setAbsenceNotes)
      .catch(() => {})
  }, [eventId, refreshKey])

  useEffect(() => {
    if (!eventId || records.length === 0) return
    getRiskyCheckIns(eventId)
      .then(setRiskyIds)
      .catch(() => {})
  }, [eventId, records.length])

  async function saveAbsenceNote() {
    if (!absenceTarget || !absenceInput.trim()) return
    setAbsenceSaving(true)
    try {
      await upsertAbsenceNote(eventId, absenceTarget.id, absenceInput.trim(), user!.userId)
      setAbsenceNotes((m) => new Map(m).set(absenceTarget.id, absenceInput.trim()))
      addAuditLog({
        action: 'absence.note_set',
        actorId: user!.userId,
        actorName: formatName(user),
        eventId,
        targetId: absenceTarget.id,
        targetName: [absenceTarget.first_name, absenceTarget.last_name].filter(Boolean).join(' ') || absenceTarget.id,
        details: { reason: absenceInput.trim() },
      }).catch(() => {})
      setAbsenceTarget(null)
      setAbsenceInput('')
    } catch (err: any) {
      setError(err.message || 'Could not save note')
    } finally {
      setAbsenceSaving(false)
    }
  }

  const [filterLevel, setFilterLevel] = useState<string | null>(urlLevel)
  const [filterChurchId, setFilterChurchId] = useState<string | null>(urlChurchId)
  const [filterChurchName, setFilterChurchName] = useState<string | null>(urlChurchName)

  // Keep scope filter in sync when navigating from dashboard stat cards (same route, new search).
  useEffect(() => {
    setFilterLevel(urlLevel)
    setFilterChurchId(urlChurchId)
    setFilterChurchName(urlChurchName)
  }, [urlLevel, urlChurchId, urlChurchName])

  const scopeOptions = useMemo(() => {
    if (!event) return []
    const topChildLevel = childScopeLevel(event.scope_level)
    if (!topChildLevel) return []
    const idCol = `${topChildLevel}_id`
    const nameCol = `${topChildLevel}_name`
    const seen = new Map<string, string>()
    for (const m of safeAllEligible) {
      if (m[idCol] && !seen.has(m[idCol])) seen.set(m[idCol], m[nameCol] || m[idCol])
    }
    return [
      { level: topChildLevel, id: '__all__', name: `All ${cap(topChildLevel)}s` },
      ...[...seen.entries()]
        .map(([id, name]) => ({ level: topChildLevel, id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ]
  }, [event, safeAllEligible])

  async function refresh() {
    try {
      const recs = await listCheckedIn(eventId)
      setRecords(recs)
    } catch (err: any) {
      setError(err.message)
    }
  }

  // Mirror EventDashboard: leaders use viewerSlice; scope URL from stat cards may
  // match viewerScope without hierarchy columns on every profile row.
  const eligible = useMemo(() => {
    const canViewWholeEvent = !!(viewerCaps?.canManage || viewerCaps?.canViewFullEvent)
    const base = canViewWholeEvent
      ? safeAllEligible
      : safeViewerSlice.length > 0
        ? safeViewerSlice
        : safeAllEligible
    const vs = viewerCaps?.viewerScope
    if (!filterLevel || !filterChurchId || filterChurchId === '__all__') return base
    if (!canViewWholeEvent && vs?.level === filterLevel && vs?.id === filterChurchId) return base
    // Mirror EventDashboard's scopedMembers filter: multi-scope members carry
    // a scope_ids map and must match on that before falling back to the
    // single ${level}_id column, or they'd show on the dashboard drill-down
    // but silently drop out of the filtered report/export.
    const idCol = `${filterLevel}_id`
    return base.filter((m) => {
      if (m == null || m.id == null) return false
      const scopeIds: string[] | undefined = (m.scope_ids as any)?.[filterLevel]
      if (scopeIds?.length) return scopeIds.includes(filterChurchId)
      return (m as any)[idCol] === filterChurchId
    })
  }, [safeAllEligible, safeViewerSlice, viewerCaps?.canManage, viewerCaps?.canViewFullEvent, viewerCaps?.viewerScope, filterLevel, filterChurchId])

  const buckets = useMemo(() => {
    const recordByMember = new Map(records.map((r) => [r.member_id, r]))
    const checkedIn: { member: any; record: any }[] = []
    const defaulted: { member: any; record: null }[] = []
    for (const m of eligible) {
      const r = recordByMember.get(m.id)
      if (r) checkedIn.push({ member: m, record: r })
      else defaulted.push({ member: m, record: null })
    }
    return { checkedIn, defaulted }
  }, [eligible, records])

  const counts: Record<TabId, number> = {
    'checked-in': buckets.checkedIn.length,
    defaulted: buckets.defaulted.length,
    timeline: records.length,
  }

  const timelineRows = useMemo(() => {
    const eligibleSet = new Set(eligible.map((m) => m.id))
    return records
      .filter((r) => eligibleSet.has(r.member_id))
      .map((r) => ({
        record: r,
        member: eligible.find((m) => m.id === r.member_id) || {
          id: r.member_id,
          first_name: r.member_name || r.member_id,
          last_name: '',
          bacenta_name: r.member_unit_name || '',
        },
      }))
      .sort((a, b) => new Date(a.record.checked_in_at).getTime() - new Date(b.record.checked_in_at).getTime())
  }, [records, eligible])

  const tabRows =
    activeTab === 'timeline'
      ? []
      : (buckets[activeTab === 'checked-in' ? 'checkedIn' : 'defaulted'] ?? [])

  // Deferred so keystrokes commit instantly; the list re-filters at lower
  // priority (React 19 concurrent rendering — no debounce timer needed).
  const deferredSearch = useDeferredValue(search)
  const filteredRows = useMemo(() => filterRows(tabRows, deferredSearch), [tabRows, deferredSearch])

  const filteredTimeline = useMemo(() => {
    const s = deferredSearch.trim().toLowerCase()
    if (!s) return timelineRows
    return timelineRows.filter((b) => {
      const m = b.member
      return [m.first_name, m.last_name, m.bacenta_name, m.governorship_name, m.council_name, m.stream_name].some(
        (v) => (v || '').toLowerCase().includes(s),
      )
    })
  }, [timelineRows, deferredSearch])

  const namesPage = useClientPagination(
    filteredRows,
    NAMES_PAGE_SIZE,
    `${activeTab}|${filterChurchId || ''}|${deferredSearch}`,
  )
  const timelinePage = useClientPagination(
    filteredTimeline,
    TIMELINE_PAGE_SIZE,
    `timeline|${deferredSearch}`,
  )

  const handleAddNote = useCallback((m: any) => {
    setAbsenceTarget(m)
    setAbsenceInput(absenceNotes.get(m.id) || '')
  }, [absenceNotes])

  function setTab(id: TabId) {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('tab', id)
      return next
    }, { replace: true })
  }

  function exportCsv() {
    if (!event || activeTab === 'timeline') return
    const rows = buckets[activeTab === 'checked-in' ? 'checkedIn' : 'defaulted']
    const statusLabel = activeTab === 'checked-in' ? 'Present' : 'Absent'
    const csv = Papa.unparse(rows.map((b) => csvRow(b, statusLabel)))
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const safe = event.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
    const scopeSuffix = filterChurchName ? `-${filterChurchName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}` : ''
    a.href = url
    a.download = `${safe}${scopeSuffix}-${activeTab}-${format(new Date(event.starts_at), 'yyyy-MM-dd')}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast('Report exported', 'success')
  }

  if (displayError) {
    return (
      <CenterCard>
        <p className='text-destructive'>{displayError}</p>
      </CenterCard>
    )
  }
  // Progressive shell — metric cards + tab bar + row placeholders instead of
  // a blocking full-page spinner.
  if (initialLoading || !event || !viewerCaps) {
    return (
      <PageShell>
        <ScreenHeader title='Report' back={{ to: `/events/${eventId}`, label: 'Back to Dashboard' }} />
        <PageMain className='flex flex-col gap-5'>
          <Skeleton className='h-4 w-3/4' />
          <Skeleton className='h-[88px] rounded-2xl' />
          <Skeleton className='h-11 rounded-xl' />
          <SkeletonRows count={5} />
        </PageMain>
      </PageShell>
    )
  }
  if (!viewerCaps.canManage && !viewerCaps.canCheckIn && !viewerCaps.canView) {
    return (
      <CenterCard>
        <p className='text-muted-foreground'>This event isn&apos;t part of your church.</p>
      </CenterCard>
    )
  }

  return (
    <PageShell>
      <ScreenHeader
        title={event.name}
        back={{ to: `/events/${eventId}`, label: 'Back to Dashboard' }}
        right={
          viewerCaps.canManage ? (
            <Button type='button' variant='outline' size='sm' className='border-success text-success' onClick={exportCsv}>
              Export CSV
            </Button>
          ) : null
        }
      />

      <PageMain className='flex flex-col gap-5'>
        <p className='section-heading m-0 flex flex-wrap items-center gap-1'>
          <StatusBadge status={event.status} />
          <span>
            {event.scope_church_name} · {event.scope_level} · {format(new Date(event.starts_at), 'PP')} · Admin:{' '}
            {event.created_by_name || '—'}
          </span>
        </p>

        {scopeOptions.length > 1 && (
          <div className='flex flex-col gap-1.5'>
            <Label className='section-heading'>Filter by church</Label>
            <Select
              value={filterChurchId || '__all__'}
              aria-label='Filter by church'
              onChange={(e) => {
                const opt = scopeOptions.find((o) => o.id === e.target.value)
                setFilterChurchId(opt?.id === '__all__' ? null : opt?.id || null)
                setFilterLevel(opt?.id === '__all__' ? null : opt?.level || null)
                setFilterChurchName(opt?.id === '__all__' ? null : opt?.name || null)
              }}
            >
              {scopeOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </div>
        )}

        <Card>
          <CardContent className='metric-grid grid-cols-2 gap-2 p-4 text-center'>
            <MetricStat value={counts['checked-in']} label='Present' tone='success' />
            <MetricStat value={counts.defaulted} label='Absent' tone='destructive' />
          </CardContent>
        </Card>

        <div className='tab-bar'>
          {TABS.map((t) => (
            <button
              key={t.id}
              type='button'
              onClick={() => setTab(t.id)}
              className={cn('tab-item flex items-center justify-center gap-1.5', activeTab === t.id && 'tab-item--active')}
            >
              {t.label}
              <span className='chip tnum text-[10px]'>{counts[t.id]}</span>
            </button>
          ))}
        </div>

        <input
          type='search'
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder='Search name or unit…'
          className='input-field'
        />

        {activeTab === 'timeline' ? (
          <Card className='overflow-hidden p-0'>
            <CardContent className='p-0'>
              {filteredTimeline.length === 0 ? (
                <p className='py-8 text-center text-sm text-muted-foreground'>No check-ins yet.</p>
              ) : (
                <>
                  {timelinePage.pageItems.map((b, i) => (
                    <TimelineEntry
                      key={b.record.id}
                      entry={b}
                      isLast={i === timelinePage.pageItems.length - 1}
                    />
                  ))}
                  <div className='border-t border-border px-3 py-3'>
                    <PaginationControls
                      page={timelinePage.page}
                      totalPages={timelinePage.totalPages}
                      total={timelinePage.total}
                      pageSize={TIMELINE_PAGE_SIZE}
                      onPageChange={timelinePage.setPage}
                      noun='check-ins'
                    />
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className='grid grid-cols-1 gap-2 md:grid-cols-2'>
            {filteredRows.length === 0 && (
              <p className='mt-2 text-center text-sm text-muted-foreground md:col-span-2'>
                {tabRows.length === 0 ? 'Nothing here yet.' : 'No matches.'}
              </p>
            )}
            {namesPage.pageItems.map((b) => (
              <ListRow
                key={b.member.id}
                entry={b}
                tab={activeTab}
                canManuallyCheckIn={viewerCaps.canManuallyCheckIn}
                isRisky={riskyIds.has(b.member.id)}
                absenceNote={activeTab === 'defaulted' ? absenceNotes.get(b.member.id) : undefined}
                onManual={setModalMember}
                onAddNote={activeTab === 'defaulted' && viewerCaps.canManage ? handleAddNote : undefined}
              />
            ))}
            {filteredRows.length > 0 && (
              <div className='md:col-span-2'>
                <PaginationControls
                  page={namesPage.page}
                  totalPages={namesPage.totalPages}
                  total={namesPage.total}
                  pageSize={NAMES_PAGE_SIZE}
                  onPageChange={namesPage.setPage}
                  noun='names'
                />
              </div>
            )}
          </div>
        )}
      </PageMain>

      {modalMember && (
        <ManualCheckInModal
          event={event}
          member={modalMember}
          onClose={() => setModalMember(null)}
          onSuccess={() => {
            setModalMember(null)
            refresh()
          }}
        />
      )}

      <Modal open={!!absenceTarget} onClose={() => setAbsenceTarget(null)} variant='sheet'>
        <h2 className='m-0 text-base font-semibold text-foreground'>Absence Reason</h2>
        <p className='m-0 mt-1 text-sm text-muted-foreground'>
          {absenceTarget &&
            ([absenceTarget.first_name, absenceTarget.last_name].filter(Boolean).join(' ') || absenceTarget.id)}
        </p>
        <Textarea
          value={absenceInput}
          onChange={(e) => setAbsenceInput(e.target.value)}
          placeholder='Enter absence reason…'
          rows={3}
          className='mt-3 min-h-0'
        />
        <div className='mt-4 flex gap-3'>
          <Button type='button' variant='outline' className='flex-1' onClick={() => setAbsenceTarget(null)}>
            Cancel
          </Button>
          <Button
            type='button'
            className='flex-1'
            disabled={absenceSaving || !absenceInput.trim()}
            onClick={saveAbsenceNote}
          >
            {absenceSaving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </Modal>
    </PageShell>
  )
}

function cap(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

function MetricStat({
  value,
  label,
  tone,
}: {
  value: number
  label: string
  tone?: 'success' | 'warning' | 'destructive' | 'muted'
}) {
  return (
    <div>
      <p
        className={cn(
          'tnum m-0 text-2xl font-bold tracking-tight',
          tone === 'success' && 'text-success',
          tone === 'warning' && 'text-warning',
          tone === 'destructive' && 'text-destructive',
          tone === 'muted' && 'text-muted-foreground',
          !tone && 'text-foreground',
        )}
      >
        {value}
      </p>
      <p className='m-0 mt-0.5 text-[10px] uppercase tracking-widest text-muted-foreground'>{label}</p>
    </div>
  )
}

function toWaPhone(phone: string | null | undefined): string | null {
  if (!phone) return null
  const d = phone.replace(/\D/g, '')
  if (d.startsWith('0') && d.length === 10) return '233' + d.slice(1)
  return d || null
}

// Memoised — the grid parent re-renders on every records refresh / search
// keystroke, but an individual card's props rarely change. Callbacks receive
// the row's member so parents can pass stable handlers.
const ListRow = memo(function ListRow({
  entry,
  tab,
  canManuallyCheckIn,
  onManual,
  absenceNote,
  onAddNote,
  isRisky = false,
}: {
  entry: { member: any; record: any }
  tab: TabId
  canManuallyCheckIn: boolean
  onManual: (member: any) => void
  absenceNote?: string
  onAddNote?: (member: any) => void
  isRisky?: boolean
}) {
  const { member, record } = entry
  const name = [member.first_name, member.last_name].filter(Boolean).join(' ') || member.id
  const unit = member.bacenta_name || member.governorship_name || member.council_name || member.stream_name || '—'
  const initials = [(member.first_name || '')[0], (member.last_name || '')[0]].filter(Boolean).join('').toUpperCase() || '?'
  const phone: string | null = member.phone || null
  const waPhone = toWaPhone(phone)

  const hasActions = phone || tab === 'defaulted'

  return (
    <div className={cn(
      'overflow-hidden rounded-2xl border bg-card',
      isRisky ? 'border-destructive/40' : 'border-border',
    )}>
      {/* Identity row */}
      <div className='flex items-center gap-3 p-4'>
        <div className='relative shrink-0'>
          {member.picture_url ? (
            <img
              src={member.picture_url}
              alt={name}
              className='h-12 w-12 rounded-full object-cover'
            />
          ) : (
            <div className='flex h-12 w-12 items-center justify-center rounded-full bg-muted text-sm font-bold text-muted-foreground'>
              {initials}
            </div>
          )}
          {isRisky && (
            <span
              className='absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[9px] text-white'
              title='Device fingerprint shared with another member — possible proxy check-in'
            >⚠</span>
          )}
        </div>
        <div className='min-w-0 flex-1'>
          <p className='m-0 truncate text-sm font-semibold text-foreground'>{name}</p>
          <p className='m-0 mt-0.5 truncate text-xs text-muted-foreground'>{unit}</p>
        </div>
        {/* Check-in time + method (non-defaulted) */}
        {tab !== 'defaulted' && record && (
          <div className='shrink-0 text-right'>
            <p className='m-0 text-sm font-bold text-foreground'>{format(new Date(record.checked_in_at), 'HH:mm')}</p>
            <div className='mt-0.5 flex justify-end gap-1'>
              <MethodTag>{record.method}</MethodTag>
            </div>
          </div>
        )}
        {tab === 'defaulted' && absenceNote && (
          <span className='max-w-[90px] truncate text-[10px] text-muted-foreground' title={absenceNote}>
            {absenceNote}
          </span>
        )}
      </div>

      {/* Action buttons row */}
      {hasActions && (
        <div className='flex gap-2 border-t border-border px-4 py-2.5'>
          {phone && (
            <>
              <a
                href={`tel:${phone}`}
                className='flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border py-2 text-xs font-semibold text-foreground no-underline active:bg-muted'
              >
                <svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
                  <path d='M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.37a2 2 0 0 1 1.99-2.18h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.91a16 16 0 0 0 6 6l.92-.92a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z' />
                </svg>
                Call
              </a>
              {waPhone && (
                <a
                  href={`https://wa.me/${waPhone}`}
                  target='_blank'
                  rel='noreferrer'
                  className='flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[#25D366]/50 py-2 text-xs font-semibold text-[#25D366] no-underline active:bg-[#25D366]/10'
                >
                  <svg viewBox='0 0 24 24' width='14' height='14' fill='currentColor'>
                    <path d='M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51a12.8 12.8 0 0 0-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z' />
                  </svg>
                  WhatsApp
                </a>
              )}
            </>
          )}
          {tab === 'defaulted' && canManuallyCheckIn && (
            <Button type='button' variant='outline' size='sm' className='flex-1 border-success text-success' onClick={() => onManual(member)}>
              Check In
            </Button>
          )}
          {tab === 'defaulted' && onAddNote && (
            <Button type='button' variant='outline' size='sm' className='flex-1' onClick={() => onAddNote(member)}>
              {absenceNote ? 'Edit Note' : 'Add Note'}
            </Button>
          )}
        </div>
      )}
    </div>
  )
})

function MethodTag({ children }: { children: ReactNode }) {
  return <Badge variant='outline' className='text-[10px] uppercase tracking-wide'>{children}</Badge>
}

function TimelineEntry({
  entry,
  isLast,
}: {
  entry: { record: any; member: any }
  isLast: boolean
}) {
  const { record: r, member: m } = entry
  const name = [m.first_name, m.last_name].filter(Boolean).join(' ') || m.id
  const unit = m.bacenta_name || m.governorship_name || m.council_name || m.stream_name || '—'
  const checkInTime = format(new Date(r.checked_in_at), 'HH:mm')

  return (
    <div className={cn('flex items-start gap-3 px-4 py-3', !isLast && 'border-b border-border')}>
      <div className='flex min-w-11 shrink-0 flex-col items-end'>
        <span className='tnum text-xs font-bold text-foreground'>{checkInTime}</span>
      </div>
      <div className='min-w-0 flex-1'>
        <p className='m-0 truncate text-sm font-semibold text-foreground'>{name}</p>
        <p className='m-0 mt-0.5 truncate text-xs text-muted-foreground'>{unit}</p>
      </div>
      <div className='flex shrink-0 flex-col items-end gap-1'>
        <MethodTag>{r.method}</MethodTag>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === 'ACTIVE' ? 'success' : status === 'PAUSED' ? 'warning' : status === 'ENDED' ? 'muted' : 'outline'
  return (
    <Badge variant={variant as 'success' | 'warning' | 'muted' | 'outline'} className='text-[10px]'>
      {status}
    </Badge>
  )
}

function filterRows(rows: { member: any; record: any }[], q: string) {
  const s = q.trim().toLowerCase()
  const valid = rows.filter((b) => b?.member?.id)
  if (!s) return valid
  return valid.filter((b) => {
    const m = b.member
    return [m.first_name, m.last_name, m.bacenta_name, m.governorship_name, m.council_name, m.stream_name].some((v) =>
      (v || '').toLowerCase().includes(s),
    )
  })
}

function csvRow(b: { member: any; record: any }, status: string) {
  const m = b.member
  const r = b.record
  return {
    Name: [m.first_name, m.last_name].filter(Boolean).join(' '),
    Role: (m.roles || [])[0] || '',
    Unit: m.bacenta_name || m.governorship_name || m.council_name || m.stream_name || '',
    Status: status,
    'Checked In At': r?.checked_in_at ? format(new Date(r.checked_in_at), 'yyyy-MM-dd HH:mm:ss') : '',
    Method: r?.method || '',
    'Geo Verified': r ? (r.geo_verified ? 'Yes' : 'No') : '',
  }
}
