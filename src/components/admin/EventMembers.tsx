import { memo, useEffect, useMemo, useState, useDeferredValue } from 'react'
import { useSearchParams } from 'react-router-dom'
import VirtualList from '../VirtualList'
import { Skeleton, SkeletonRows } from '../ui/skeleton'
import { toast } from '../Toast'
import { format } from 'date-fns'
import Papa from 'papaparse'
import ScreenHeader from '../ScreenHeader'
import ManualCheckInModal from './ManualCheckInModal'
import { PageShell, PageMain } from '../layout/PageShell'
import { CenterCard } from '../layout/CenterCard'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { Label } from '../ui/label'
import { Select } from '../ui/select'
import { cn } from '../../lib/utils'
import {
  listCheckedIn,
  getRiskyCheckIns,
} from '../../utils/supabaseCheckins'
import { childScopeLevel } from '../../utils/membersApi'
import { getCurrentUser } from '../../utils/auth'
import { useEventEligibility } from '../../hooks/useEventEligibility'
import { useRefreshSignal } from '../../hooks/useRefreshSignal'

type Status = 'present' | 'absent' | 'all'

const STATUS_TITLES: Record<Status, string> = {
  present: 'Leaders Present',
  absent:  'Leaders Absent',
  all:     'All Expected Leaders',
}

function membersWithId(list: any[] | null | undefined): any[] {
  return (list || []).filter((m) => m != null && m.id != null && m.id !== '')
}

function cap(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

export default function EventMembers({ eventId }: { eventId: string }) {
  const user = getCurrentUser()
  const [params] = useSearchParams()

  const status     = (params.get('status') || 'all') as Status
  const urlLevel   = params.get('level')      || null
  const urlChurchId  = params.get('churchId')  || null
  const urlChurchName = params.get('churchName') || null

  const [refreshKey, setRefreshKey] = useState(0)
  useRefreshSignal(() => setRefreshKey((k) => k + 1))

  const {
    event, eligible: allEligible, viewerSlice, viewerCaps, records,
    error: eligibilityError, initialLoading, setRecords,
  } = useEventEligibility(eventId, user, { refreshKey })

  const safeAllEligible = useMemo(() => membersWithId(allEligible), [allEligible])
  const safeViewerSlice = useMemo(() => membersWithId(viewerSlice), [viewerSlice])

  const [search, setSearch]       = useState('')
  const [error, setError]         = useState<string | null>(null)
  const [modalMember, setModalMember] = useState<any>(null)
  const [riskyIds, setRiskyIds] = useState<Set<string>>(new Set())
  const [filterLevel,      setFilterLevel]      = useState<string | null>(urlLevel)
  const [filterChurchId,   setFilterChurchId]   = useState<string | null>(urlChurchId)
  const [filterChurchName, setFilterChurchName] = useState<string | null>(urlChurchName)

  useEffect(() => {
    setFilterLevel(urlLevel)
    setFilterChurchId(urlChurchId)
    setFilterChurchName(urlChurchName)
  }, [urlLevel, urlChurchId, urlChurchName])

  useEffect(() => {
    if (!eventId || records.length === 0) return
    getRiskyCheckIns(eventId).then(setRiskyIds).catch(() => {})
  }, [eventId, records.length])

  const scopeOptions = useMemo(() => {
    if (!event) return []
    const topChildLevel = childScopeLevel(event.scope_level)
    if (!topChildLevel) return []
    const idCol   = `${topChildLevel}_id`
    const nameCol = `${topChildLevel}_name`
    const seen = new Map<string, string>()
    for (const m of safeAllEligible) {
      if (m[idCol] && !seen.has(m[idCol])) seen.set(m[idCol], m[nameCol] || m[idCol])
    }
    return [
      { level: topChildLevel, id: '__all__', name: `All ${cap(topChildLevel)}s` },
      ...[...seen.entries()].map(([id, name]) => ({ level: topChildLevel, id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    ]
  }, [event, safeAllEligible])

  const eligible = useMemo(() => {
    const isAdmin = !!viewerCaps?.canManage
    const base = isAdmin ? safeAllEligible : (safeViewerSlice.length > 0 ? safeViewerSlice : safeAllEligible)
    const vs = viewerCaps?.viewerScope
    if (!filterLevel || !filterChurchId || filterChurchId === '__all__') return base
    if (!isAdmin && vs?.level === filterLevel && vs?.id === filterChurchId) return base
    const idCol = `${filterLevel}_id`
    return base.filter((m) => m[idCol] === filterChurchId)
  }, [safeAllEligible, safeViewerSlice, viewerCaps?.canManage, viewerCaps?.viewerScope, filterLevel, filterChurchId])

  const rows = useMemo(() => {
    const byMember = new Map(records.map((r) => [r.member_id, r]))
    if (status === 'present')
      return eligible.filter((m) => byMember.has(m.id)).map((m) => ({ member: m, record: byMember.get(m.id) }))
    if (status === 'absent') {
      const notStarted = !!event?.starts_at && new Date(event.starts_at) > new Date()
      return notStarted
        ? []
        : eligible.filter((m) => !byMember.has(m.id)).map((m) => ({ member: m, record: null }))
    }
    return eligible.map((m) => ({ member: m, record: byMember.get(m.id) || null }))
  }, [eligible, records, status, event?.starts_at])

  // Deferred so keystrokes commit instantly; the list re-filters at lower
  // priority (React 19 concurrent rendering — no debounce timer needed).
  const deferredSearch = useDeferredValue(search)
  const filteredRows = useMemo(() => {
    const s = deferredSearch.trim().toLowerCase()
    const valid = rows.filter((b) => b?.member?.id)
    if (!s) return valid
    return valid.filter(({ member: m }) =>
      [m.first_name, m.last_name, m.bacenta_name, m.governorship_name, m.council_name, m.stream_name]
        .some((v) => (v || '').toLowerCase().includes(s)),
    )
  }, [rows, deferredSearch])

  async function refresh() {
    try { setRecords(await listCheckedIn(eventId)) }
    catch (err: any) { setError(err.message) }
  }

  function exportCsv() {
    if (!event) return
    const csv = Papa.unparse(filteredRows.map(({ member: m, record: r }) => ({
      Name:   [m.first_name, m.last_name].filter(Boolean).join(' '),
      Unit:   m.bacenta_name || m.governorship_name || m.council_name || m.stream_name || '',
      Status: !r ? 'Absent' : r.checked_out_at ? 'Checked Out' : 'Checked In',
      'Checked In At':  r?.checked_in_at  ? format(new Date(r.checked_in_at),  'yyyy-MM-dd HH:mm:ss') : '',
      'Checked Out At': r?.checked_out_at ? format(new Date(r.checked_out_at), 'yyyy-MM-dd HH:mm:ss') : '',
      Method: r?.method || '',
      Phone:  m.phone || '',
    })))
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    const safe = event.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
    const scope = filterChurchName ? `-${filterChurchName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}` : ''
    a.href     = url
    a.download = `${safe}${scope}-${status}-${format(new Date(event.starts_at), 'yyyy-MM-dd')}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast('Report exported', 'success')
  }

  const displayError = error || eligibilityError

  if (displayError)  return <CenterCard><p className='text-destructive'>{displayError}</p></CenterCard>
  // Progressive shell — header + search + row placeholders instead of a
  // blocking full-page spinner.
  if (initialLoading || !event || !viewerCaps) {
    return (
      <PageShell>
        <ScreenHeader title={STATUS_TITLES[status] || 'Members'} back={{ to: `/events/${eventId}`, label: 'Dashboard' }} />
        <PageMain className='flex flex-col gap-4'>
          <Skeleton className='h-4 w-2/3' />
          <Skeleton className='h-11 rounded-xl' />
          <SkeletonRows count={7} />
        </PageMain>
      </PageShell>
    )
  }
  if (!viewerCaps.canManage && !viewerCaps.canCheckIn && !viewerCaps.canView) {
    return <CenterCard><p className='text-muted-foreground'>This event isn&apos;t part of your scope.</p></CenterCard>
  }

  const eventEnded = !!event.ends_at && new Date() > new Date(event.ends_at)
  const title = STATUS_TITLES[status] || 'Members'

  return (
    <PageShell>
      <ScreenHeader
        title={title}
        back={{ to: `/events/${eventId}`, label: 'Dashboard' }}
        right={
          viewerCaps.canManage ? (
            <Button type='button' variant='outline' size='sm' onClick={exportCsv}>Export</Button>
          ) : null
        }
      />

      <PageMain className='flex flex-col gap-4'>
        <p className='section-heading m-0 text-muted-foreground'>
          {event.name} · <span className='text-foreground font-bold'>{filteredRows.length}</span> {status === 'present' ? 'present' : status === 'absent' ? 'absent' : 'expected'}
        </p>

        {scopeOptions.length > 1 && (
          <div className='flex flex-col gap-1.5'>
            <Label className='section-heading'>Filter by scope</Label>
            <Select
              value={filterChurchId || '__all__'}
              aria-label='Filter by scope'
              onChange={(e) => {
                const opt = scopeOptions.find((o) => o.id === e.target.value)
                setFilterChurchId(opt?.id === '__all__' ? null : opt?.id || null)
                setFilterLevel(opt?.id === '__all__' ? null : opt?.level || null)
                setFilterChurchName(opt?.id === '__all__' ? null : opt?.name || null)
              }}
            >
              {scopeOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
          </div>
        )}

        <input
          type='search'
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder='Search name or unit…'
          className='input-field'
        />

        <div>
          {filteredRows.length === 0 && (
            <p className='mt-4 text-center text-sm text-muted-foreground'>
              {rows.length === 0 ? 'Nobody here yet.' : 'No matches.'}
            </p>
          )}
          <VirtualList
            items={filteredRows}
            getKey={(b) => b.member.id}
            estimateSize={70}
            renderRow={(b) => (
              <MemberCard
                entry={b}
                status={status}
                canManuallyCheckIn={viewerCaps.canManuallyCheckIn && !eventEnded}
                isRisky={riskyIds.has(b.member.id)}
                onManual={setModalMember}
              />
            )}
          />
        </div>
      </PageMain>

      {modalMember && (
        <ManualCheckInModal
          event={event}
          member={modalMember}
          onClose={() => setModalMember(null)}
          onSuccess={() => { setModalMember(null); refresh() }}
        />
      )}

    </PageShell>
  )
}

// ─── MemberCard ───────────────────────────────────────────────────────────────


// Memoised — the list parent re-renders on every records refresh / search
// keystroke, but an individual card's props rarely change.
const MemberCard = memo(function MemberCard({
  entry, status, canManuallyCheckIn,
  onManual, isRisky = false,
}: {
  entry: { member: any; record: any }
  status: Status
  canManuallyCheckIn: boolean
  /** Called with the row's member — stable across renders (setState). */
  onManual: (member: any) => void
  isRisky?: boolean
}) {
  const { member: m, record: r } = entry
  const name     = [m.first_name, m.last_name].filter(Boolean).join(' ') || m.id
  const unit     = m.bacenta_name || m.governorship_name || m.council_name || m.stream_name || '—'
  const initials = [(m.first_name || '')[0], (m.last_name || '')[0]].filter(Boolean).join('').toUpperCase() || '?'
  const phone: string | null = m.phone || null
  const isAbsent = !r

  const showPhone   = !!phone
  const showCheckIn = isAbsent && canManuallyCheckIn
  const hasActions  = showPhone || showCheckIn

  return (
    <div className={cn('flex items-center gap-2 overflow-hidden rounded-2xl border bg-card', isRisky ? 'border-destructive/40' : 'border-border')}>
      {/* Identity + status */}
      <div className='flex flex-1 items-center gap-3 p-3 min-w-0'>
        <div className='relative shrink-0'>
          {m.picture_url ? (
            <img src={m.picture_url} alt={name} className='h-11 w-11 rounded-full object-cover' />
          ) : (
            <div className='flex h-11 w-11 items-center justify-center rounded-full bg-muted text-sm font-bold text-muted-foreground'>{initials}</div>
          )}
          {isRisky && (
            <span className='absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[9px] text-white' title='Device fingerprint shared with another member'>⚠</span>
          )}
        </div>
        <div className='min-w-0 flex-1'>
          <p className='m-0 truncate text-sm font-semibold text-foreground'>{name}</p>
          <p className='m-0 mt-0.5 truncate text-xs text-muted-foreground'>{unit}</p>
        </div>
        <div className='shrink-0 text-right'>
          {status === 'all' && (
            <Badge variant={isAbsent ? 'warning' : r?.checked_out_at ? 'muted' : 'success'} className='text-[10px]'>
              {isAbsent ? 'Absent' : r?.checked_out_at ? 'Left' : 'Present'}
            </Badge>
          )}
          {!isAbsent && r?.checked_in_at && (
            <p className='m-0 mt-0.5 text-[11px] text-muted-foreground'>{format(new Date(r.checked_in_at), 'HH:mm')}</p>
          )}
          {!isAbsent && r?.method && (
            <Badge variant='outline' className='mt-0.5 text-[10px] uppercase tracking-wide'>{r.method}</Badge>
          )}
          {!isAbsent && r?.is_late && <Badge variant='warning' className='mt-0.5 text-[10px]'>Late</Badge>}
        </div>
      </div>

      {/* Icon action buttons */}
      {hasActions && (
        <div className='flex shrink-0 items-center gap-2 pr-3'>
          {showPhone && (
            <a
              href={`tel:${phone}`}
              className='flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl border border-border text-muted-foreground no-underline hover:bg-accent hover:text-foreground'
              title='Call'
              aria-label={`Call ${name}`}
            >
              <PhoneIcon />
            </a>
          )}
          {showCheckIn && (
            <button
              type='button'
              onClick={() => onManual(m)}
              className='flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl border border-success/40 text-success hover:bg-success/10'
              title='Manual check-in'
              aria-label={`Check in ${name}`}
            >
              <CheckInIcon />
            </button>
          )}
        </div>
      )}
    </div>
  )
})

function PhoneIcon() {
  return (
    <svg viewBox='0 0 24 24' width='15' height='15' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
      <path d='M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.37a2 2 0 0 1 1.99-2.18h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.91a16 16 0 0 0 6 6l.92-.92a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z' />
    </svg>
  )
}

function CheckInIcon() {
  return (
    <svg viewBox='0 0 24 24' width='15' height='15' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
      <path d='M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' />
      <circle cx='9' cy='7' r='4' />
      <polyline points='16 11 18 13 22 9' />
    </svg>
  )
}


