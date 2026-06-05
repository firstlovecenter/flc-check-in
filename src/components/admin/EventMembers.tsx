import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import Spinner from '../Spinner'
import { format } from 'date-fns'
import Papa from 'papaparse'
import ScreenHeader from '../ScreenHeader'
import ManualCheckInModal from './ManualCheckInModal'
import { PageShell, PageMain } from '../layout/PageShell'
import { CenterCard } from '../layout/CenterCard'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { Label } from '../ui/label'
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
  const [absenceNotes, setAbsenceNotes]   = useState<Map<string, string>>(new Map())
  const [absenceTarget, setAbsenceTarget] = useState<any | null>(null)
  const [absenceInput, setAbsenceInput]   = useState('')
  const [absenceSaving, setAbsenceSaving] = useState(false)
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
    if (!eventId) return
    listAbsenceNotesForEvent(eventId).then(setAbsenceNotes).catch(() => {})
  }, [eventId, refreshKey])

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
    if (status === 'absent')
      return eligible.filter((m) => !byMember.has(m.id)).map((m) => ({ member: m, record: null }))
    return eligible.map((m) => ({ member: m, record: byMember.get(m.id) || null }))
  }, [eligible, records, status])

  const filteredRows = useMemo(() => {
    const s = search.trim().toLowerCase()
    const valid = rows.filter((b) => b?.member?.id)
    if (!s) return valid
    return valid.filter(({ member: m }) =>
      [m.first_name, m.last_name, m.bacenta_name, m.governorship_name, m.council_name, m.stream_name]
        .some((v) => (v || '').toLowerCase().includes(s)),
    )
  }, [rows, search])

  async function refresh() {
    try { setRecords(await listCheckedIn(eventId)) }
    catch (err: any) { setError(err.message) }
  }

  async function saveAbsenceNote() {
    if (!absenceTarget || !absenceInput.trim()) return
    setAbsenceSaving(true)
    try {
      await upsertAbsenceNote(eventId, absenceTarget.id, absenceInput.trim(), user!.userId)
      setAbsenceNotes((m) => new Map(m).set(absenceTarget.id, absenceInput.trim()))
      addAuditLog({
        action: 'absence.note_set', actorId: user!.userId, actorName: formatName(user), eventId,
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
  }

  const displayError = error || eligibilityError

  if (displayError)  return <CenterCard><p className='text-destructive'>{displayError}</p></CenterCard>
  if (initialLoading || !event || !viewerCaps) return <Spinner fullPage />
  if (!viewerCaps.canManage && !viewerCaps.canCheckIn && !viewerCaps.canView) {
    return <CenterCard><p className='text-muted-foreground'>This event isn&apos;t part of your scope.</p></CenterCard>
  }

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
            <select
              value={filterChurchId || '__all__'}
              onChange={(e) => {
                const opt = scopeOptions.find((o) => o.id === e.target.value)
                setFilterChurchId(opt?.id === '__all__' ? null : opt?.id || null)
                setFilterLevel(opt?.id === '__all__' ? null : opt?.level || null)
                setFilterChurchName(opt?.id === '__all__' ? null : opt?.name || null)
              }}
              className='input-field'
            >
              {scopeOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
        )}

        <input
          type='search'
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder='Search name or unit…'
          className='input-field'
        />

        <div className='flex flex-col gap-3'>
          {filteredRows.length === 0 && (
            <p className='mt-4 text-center text-sm text-muted-foreground'>
              {rows.length === 0 ? 'Nobody here yet.' : 'No matches.'}
            </p>
          )}
          {filteredRows.map((b) => (
            <MemberCard
              key={b.member.id}
              entry={b}
              status={status}
              canManuallyCheckIn={viewerCaps.canManuallyCheckIn}
              isRisky={riskyIds.has(b.member.id)}
              absenceNote={status !== 'present' ? absenceNotes.get(b.member.id) : undefined}
              onManual={() => setModalMember(b.member)}
              onAddNote={
                status !== 'present' && viewerCaps.canManage
                  ? () => { setAbsenceTarget(b.member); setAbsenceInput(absenceNotes.get(b.member.id) || '') }
                  : undefined
              }
            />
          ))}
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

      <Modal open={!!absenceTarget} onClose={() => setAbsenceTarget(null)} variant='sheet'>
        <h2 className='m-0 text-base font-semibold text-foreground'>Absence Reason</h2>
        <p className='m-0 mt-1 text-sm text-muted-foreground'>
          {absenceTarget &&
            ([absenceTarget.first_name, absenceTarget.last_name].filter(Boolean).join(' ') || absenceTarget.id)}
        </p>
        <Textarea value={absenceInput} onChange={(e) => setAbsenceInput(e.target.value)} placeholder='Enter absence reason…' rows={3} className='mt-3 min-h-0' />
        <div className='mt-4 flex gap-3'>
          <Button type='button' variant='outline' className='flex-1' onClick={() => setAbsenceTarget(null)}>Cancel</Button>
          <Button type='button' className='flex-1' disabled={absenceSaving || !absenceInput.trim()} onClick={saveAbsenceNote}>
            {absenceSaving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </Modal>
    </PageShell>
  )
}

// ─── MemberCard ───────────────────────────────────────────────────────────────

function toWaPhone(phone: string | null | undefined): string | null {
  if (!phone) return null
  const d = phone.replace(/\D/g, '')
  if (d.startsWith('0') && d.length === 10) return '233' + d.slice(1)
  return d || null
}

function MemberCard({
  entry, status, canManuallyCheckIn,
  onManual, absenceNote, onAddNote, isRisky = false,
}: {
  entry: { member: any; record: any }
  status: Status
  canManuallyCheckIn: boolean
  onManual: () => void
  absenceNote?: string
  onAddNote?: () => void
  isRisky?: boolean
}) {
  const { member: m, record: r } = entry
  const name     = [m.first_name, m.last_name].filter(Boolean).join(' ') || m.id
  const unit     = m.bacenta_name || m.governorship_name || m.council_name || m.stream_name || '—'
  const initials = [(m.first_name || '')[0], (m.last_name || '')[0]].filter(Boolean).join('').toUpperCase() || '?'
  const phone: string | null = m.phone || null
  const waPhone  = toWaPhone(phone)

  const isAbsent = !r
  const hasActions = phone || isAbsent

  return (
    <div className={cn('overflow-hidden rounded-2xl border bg-card', isRisky ? 'border-destructive/40' : 'border-border')}>
      {/* Identity row */}
      <div className='flex items-center gap-3 p-4'>
        <div className='relative shrink-0'>
          {m.picture_url ? (
            <img src={m.picture_url} alt={name} className='h-12 w-12 rounded-full object-cover' />
          ) : (
            <div className='flex h-12 w-12 items-center justify-center rounded-full bg-muted text-sm font-bold text-muted-foreground'>{initials}</div>
          )}
          {isRisky && (
            <span className='absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[9px] text-white' title='Device fingerprint shared with another member'>⚠</span>
          )}
        </div>
        <div className='min-w-0 flex-1'>
          <p className='m-0 truncate text-sm font-semibold text-foreground'>{name}</p>
          <p className='m-0 mt-0.5 truncate text-xs text-muted-foreground'>{unit}</p>
        </div>
        {/* Status info (right side) */}
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
          {isAbsent && absenceNote && (
            <span className='block max-w-[90px] truncate text-[10px] text-muted-foreground' title={absenceNote}>{absenceNote}</span>
          )}
        </div>
      </div>

      {/* Action buttons */}
      {hasActions && (
        <div className='flex flex-wrap gap-2 border-t border-border px-4 py-2.5'>
          {phone && (
            <>
              <a
                href={`tel:${phone}`}
                className='flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border py-2 text-xs font-semibold text-foreground no-underline active:bg-muted'
              >
                <PhoneIcon />
                Call
              </a>
              {waPhone && (
                <a
                  href={`https://wa.me/${waPhone}`}
                  target='_blank' rel='noreferrer'
                  className='flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[#25D366]/50 py-2 text-xs font-semibold text-[#25D366] no-underline active:bg-[#25D366]/10'
                >
                  <WhatsAppIcon />
                  WhatsApp
                </a>
              )}
            </>
          )}
          {isAbsent && canManuallyCheckIn && (
            <Button type='button' variant='outline' size='sm' className='flex-1 border-success text-success' onClick={onManual}>
              Check In
            </Button>
          )}
          {isAbsent && onAddNote && (
            <Button type='button' variant='outline' size='sm' className='flex-1' onClick={onAddNote}>
              {absenceNote ? 'Edit Note' : 'Add Note'}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function PhoneIcon() {
  return (
    <svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
      <path d='M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.37a2 2 0 0 1 1.99-2.18h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.91a16 16 0 0 0 6 6l.92-.92a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z' />
    </svg>
  )
}

function WhatsAppIcon() {
  return (
    <svg viewBox='0 0 24 24' width='14' height='14' fill='currentColor'>
      <path d='M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51a12.8 12.8 0 0 0-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z' />
    </svg>
  )
}
