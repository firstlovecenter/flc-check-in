import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { format, formatDistanceToNowStrict } from 'date-fns'
import Papa from 'papaparse'
import ScreenHeader from '../ScreenHeader'
import ManualCheckInModal from './ManualCheckInModal'
import {
  listCheckedIn, adminClearFaceDescriptor,
  listAbsenceNotesForEvent, upsertAbsenceNote, addAuditLog, getRiskyCheckIns,
} from '../../utils/supabaseCheckins'
import {
  childScopeLevel, adminCoversMember,
} from '../../utils/membersApi'
import { getCurrentUser, SCOPE_LEVELS } from '../../utils/auth'
import { useEventEligibility } from '../../hooks/useEventEligibility'

const TABS = [
  { id: 'checked-in', label: 'Checked In' },
  { id: 'defaulted',  label: 'Defaulted' },
  { id: 'checked-out', label: 'Checked Out' },
  { id: 'timeline',   label: 'Timeline' },
]

export default function FullReport({ eventId }) {
  const user = getCurrentUser()
  const [params, setParams] = useSearchParams()
  const activeTab = TABS.find((t) => t.id === params.get('tab'))?.id || 'checked-in'

  // Scope filter — can be passed in via URL (from ScopeBreakdown) or set interactively
  const urlLevel      = params.get('level')      || null
  const urlChurchId   = params.get('churchId')   || null
  const urlChurchName = params.get('churchName') || null

  // Core eligibility + records — SWR-cached so page is instant on revisit.
  const {
    event, eligible: allEligible, viewerCaps, adminScopes, records,
    error: eligibilityError, initialLoading, setRecords,
  } = useEventEligibility(eventId, user)

  const [search, setSearch]             = useState('')
  const [error, setError]               = useState<string | null>(null)
  const [modalMember, setModalMember]   = useState(null)
  const [resetting, setResetting]       = useState<string | null>(null)
  // Inline confirmation state for Face ID reset (replaces window.confirm).
  const [confirmResetId, setConfirmResetId] = useState<string | null>(null)

  // Absence notes state
  const [absenceNotes, setAbsenceNotes]   = useState<Map<string, string>>(new Map())
  const [absenceTarget, setAbsenceTarget] = useState<any | null>(null)
  const [absenceInput, setAbsenceInput]   = useState('')
  const [absenceSaving, setAbsenceSaving] = useState(false)

  // Risk flags — members whose device fingerprint was shared with another member
  const [riskyIds, setRiskyIds] = useState<Set<string>>(new Set())

  // Merge hook error with local errors.
  const displayError = error || eligibilityError

  // Load absence notes whenever the event is known
  useEffect(() => {
    if (!eventId) return
    listAbsenceNotesForEvent(eventId)
      .then(setAbsenceNotes)
      .catch(() => {})
  }, [eventId])

  // Load risk flags whenever records change
  useEffect(() => {
    if (!eventId || records.length === 0) return
    getRiskyCheckIns(eventId)
      .then(setRiskyIds)
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, records.length])

  async function saveAbsenceNote() {
    if (!absenceTarget || !absenceInput.trim()) return
    setAbsenceSaving(true)
    try {
      await upsertAbsenceNote(eventId, absenceTarget.id, absenceInput.trim(), user.userId)
      setAbsenceNotes((m) => new Map(m).set(absenceTarget.id, absenceInput.trim()))
      addAuditLog({
        action: 'absence.note_set',
        actorId: user.userId,
        actorName: `${user.firstName} ${user.lastName}`.trim(),
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

  // Scope filter state (level + child-church selector)
  const [filterLevel,      setFilterLevel]      = useState<string | null>(urlLevel)
  const [filterChurchId,   setFilterChurchId]   = useState<string | null>(urlChurchId)
  const [filterChurchName, setFilterChurchName] = useState<string | null>(urlChurchName)

  // Available child-scope options for the filter dropdown
  const scopeOptions = useMemo(() => {
    if (!event) return []
    // Build one level below the event scope as the top filter level
    const topChildLevel = childScopeLevel(event.scope_level)
    if (!topChildLevel) return []
    const idCol   = `${topChildLevel}_id`
    const nameCol = `${topChildLevel}_name`
    const seen = new Map<string, string>()
    for (const m of allEligible) {
      if (m[idCol] && !seen.has(m[idCol])) seen.set(m[idCol], m[nameCol] || m[idCol])
    }
    return [
      { level: topChildLevel, id: '__all__', name: `All ${cap(topChildLevel)}s` },
      ...[...seen.entries()].map(([id, name]) => ({ level: topChildLevel, id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    ]
  }, [event, allEligible])

  async function refresh() {
    try {
      const recs = await listCheckedIn(eventId)
      setRecords(recs)
    } catch (err: any) {
      setError(err.message)
    }
  }

  // Apply scope filter on top of allEligible
  const eligible = useMemo(() => {
    if (!filterChurchId || filterChurchId === '__all__' || !filterLevel) return allEligible
    const idCol = `${filterLevel}_id`
    return allEligible.filter((m) => m[idCol] === filterChurchId)
  }, [allEligible, filterLevel, filterChurchId])

  // Bucket the eligible set
  const buckets = useMemo(() => {
    const recordByMember = new Map(records.map((r) => [r.member_id, r]))
    const checkedIn = []
    const defaulted = []
    const checkedOut = []
    for (const m of eligible) {
      const r = recordByMember.get(m.id)
      if (!r) defaulted.push({ member: m, record: null })
      else if (r.checked_out_at) checkedOut.push({ member: m, record: r })
      else checkedIn.push({ member: m, record: r })
    }
    return { checkedIn, defaulted, checkedOut }
  }, [eligible, records])

  const counts = {
    'checked-in':  buckets.checkedIn.length,
    'defaulted':   buckets.defaulted.length,
    'checked-out': buckets.checkedOut.length,
    'timeline':    records.length,
  }

  // Timeline: all check-in records in scope, sorted chronologically
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
  const total = eligible.length
  const pct = total > 0 ? Math.round((counts['checked-in'] / total) * 100) : 0

  // These must live above the early-return guards to satisfy rules-of-hooks.
  const tabRows = activeTab === 'timeline'
    ? []
    : buckets[activeTab === 'checked-in' ? 'checkedIn' : activeTab === 'defaulted' ? 'defaulted' : 'checkedOut']
  const filteredRows = filterRows(tabRows, search)

  const filteredTimeline = useMemo(() => {
    const s = search.trim().toLowerCase()
    if (!s) return timelineRows
    return timelineRows.filter((b) => {
      const m = b.member
      return [m.first_name, m.last_name, m.bacenta_name, m.governorship_name, m.council_name, m.stream_name]
        .some((v) => (v || '').toLowerCase().includes(s))
    })
  }, [timelineRows, search])

  const scopeLabel = (filterChurchId && filterChurchId !== '__all__' && filterChurchName)
    ? filterChurchName
    : (event?.scope_church_name || '')

  function setTab(id) {
    setParams((p) => { p.set('tab', id); return p }, { replace: true })
  }

  function handleResetFaceId(member) {
    // Show inline confirmation instead of window.confirm (broken on iOS PWA).
    setConfirmResetId(member.id)
  }

  async function confirmResetFaceId(memberId: string) {
    setConfirmResetId(null)
    setResetting(memberId)
    try {
      await adminClearFaceDescriptor(memberId)
      const target = allEligible.find((r) => r.id === memberId)
      addAuditLog({
        action: 'face.descriptor_clear',
        actorId: user.userId,
        actorName: `${user.firstName} ${user.lastName}`.trim(),
        eventId,
        targetId: memberId,
        targetName: target ? [target.first_name, target.last_name].filter(Boolean).join(' ') : memberId,
      }).catch(() => {})
    } catch (err: any) {
      setError(err.message || 'Could not reset Face ID')
    } finally {
      setResetting(null)
    }
  }

  function exportCsv() {
    if (!event || activeTab === 'timeline') return
    // Export only the currently visible tab + scope filter
    const tabRows = buckets[activeTab === 'checked-in' ? 'checkedIn' : activeTab === 'defaulted' ? 'defaulted' : 'checkedOut']
    const statusLabel = activeTab === 'checked-in' ? 'Checked In' : activeTab === 'defaulted' ? 'Defaulted' : 'Checked Out'
    const rows = tabRows.map((b) => csvRow(b, statusLabel))
    const csv = Papa.unparse(rows)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const safe = event.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
    const scopeSuffix = filterChurchName ? `-${filterChurchName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}` : ''
    a.href = url
    a.download = `${safe}${scopeSuffix}-${activeTab}-${format(new Date(event.starts_at), 'yyyy-MM-dd')}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (displayError) return <CenterCard><p style={{ color: 'var(--coral)' }}>{displayError}</p></CenterCard>
  if (initialLoading || !event || !viewerCaps) return <CenterCard><p style={{ color: 'var(--muted)' }}>Loading…</p></CenterCard>
  if (!viewerCaps.canManage && !viewerCaps.canCheckIn && !viewerCaps.canView) {
    return <CenterCard><p style={{ color: 'var(--muted)' }}>This event isn't part of your scope.</p></CenterCard>
  }

  return (
    <div className='min-h-dvh' style={{ background: 'var(--bg)' }}>
      <ScreenHeader
        title={event.name}
        back={{ to: `/events/${eventId}`, label: 'Back to Dashboard' }}
        right={viewerCaps.canManage && (
          <button
            onClick={exportCsv}
            className='text-xs px-3 py-1.5 cursor-pointer'
            style={{
              background: 'transparent',
              color: 'var(--green)',
              border: '1.5px solid var(--green)',
              borderRadius: 'var(--radius-btn)',
            }}
          >
            Export CSV
          </button>
        )}
      />

      <main className='max-w-5xl mx-auto px-4 sm:px-6 py-6 flex flex-col gap-5'>
        <p className='eyebrow m-0'>
          <StatusPill status={event.status} /> &nbsp;
          {event.scope_level} · {format(new Date(event.starts_at), 'PP')} · Admin: {event.created_by_name || '—'}
        </p>

        {/* Scope filter */}
        {scopeOptions.length > 1 && (
          <div className='flex flex-col gap-1.5'>
            <label className='eyebrow' style={{ color: 'var(--muted)' }}>Filter by scope</label>
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
              {scopeOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Compact stat strip */}
        <div
          className='p-4 grid grid-cols-4 gap-2 text-center'
          style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-card)', boxShadow: 'var(--shadow-2)' }}
        >
          <Stat value={total} label='Expected' />
          <Stat value={counts['checked-in']}  label='Checked In'  color='var(--green)' />
          <Stat value={counts['checked-out']} label='Checked Out' color='var(--amber)' />
          <Stat value={counts['defaulted']}   label='Defaulted'   color='var(--coral)' />
        </div>

        {/* Attendance bar */}
        <div
          className='p-4'
          style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-btn)' }}
        >
          <div className='flex items-center justify-between text-xs mb-2'>
            <span style={{ color: 'var(--muted)' }}>Attendance</span>
            <span style={{ color: 'var(--accent)' }}>{pct}%</span>
          </div>
          <div className='h-2 overflow-hidden' style={{ background: 'var(--bg2)', borderRadius: 'var(--radius-pill)' }}>
            <div className='h-full' style={{ width: `${pct}%`, background: 'var(--coral)', borderRadius: 'var(--radius-pill)' }} />
          </div>
        </div>

        {/* Tabs — pill toggle */}
        <div
          className='flex gap-1 p-1'
          style={{ background: 'var(--bg2)', borderRadius: 'var(--radius-pill)', border: '1px solid var(--border)' }}
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className='flex-1 py-2 text-xs font-semibold cursor-pointer transition-colors flex items-center justify-center gap-1.5'
              style={{
                background: activeTab === t.id ? 'var(--cta-bg)' : 'transparent',
                color: activeTab === t.id ? 'var(--cta-text)' : 'var(--muted)',
                border: 'none',
                borderRadius: 'var(--radius-pill)',
                letterSpacing: '0.03em',
              }}
            >
              {t.label}
              <span
                className='text-[10px] font-bold px-1.5 py-0.5'
                style={{
                  background: activeTab === t.id ? 'rgba(255,255,255,0.2)' : 'var(--card)',
                  color: activeTab === t.id ? 'var(--cta-text)' : 'var(--muted)',
                  borderRadius: 'var(--radius-pill)',
                }}
              >
                {counts[t.id]}
              </span>
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

        {/* List / Timeline */}
        {activeTab === 'timeline' ? (
          <div
            style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-card)' }}
          >
            {filteredTimeline.length === 0 ? (
              <p className='text-sm text-center py-8' style={{ color: 'var(--muted)' }}>No check-ins yet.</p>
            ) : (
              filteredTimeline.map((b, i) => (
                <TimelineEntry
                  key={b.record.id}
                  entry={b}
                  isLast={i === filteredTimeline.length - 1}
                />
              ))
            )}
          </div>
        ) : (
          <div className='grid grid-cols-1 md:grid-cols-2 gap-2'>
            {filteredRows.length === 0 && (
              <p className='text-sm text-center mt-2 md:col-span-2' style={{ color: 'var(--muted)' }}>
                {tabRows.length === 0 ? 'Nothing here yet.' : 'No matches.'}
              </p>
            )}
            {filteredRows.map((b) => (
              <ListRow
                key={b.member.id}
                entry={b}
                tab={activeTab}
                canManage={viewerCaps.canManage}
                canResetFaceId={adminCoversMember(adminScopes, b.member)}
                resetting={resetting === b.member.id}
                isRisky={riskyIds.has(b.member.id)}
                absenceNote={activeTab === 'defaulted' ? absenceNotes.get(b.member.id) : undefined}
                onManual={() => setModalMember(b.member)}
                onResetFaceId={() => handleResetFaceId(b.member)}
                onAddNote={activeTab === 'defaulted' && viewerCaps.canManage
                  ? () => { setAbsenceTarget(b.member); setAbsenceInput(absenceNotes.get(b.member.id) || '') }
                  : undefined}
              />
            ))}
          </div>
        )}
      </main>

      {modalMember && (
        <ManualCheckInModal
          event={event}
          member={modalMember}
          onClose={() => setModalMember(null)}
          onSuccess={() => { setModalMember(null); refresh() }}
        />
      )}

      {/* Inline Face ID reset confirmation — replaces window.confirm (broken on iOS PWA) */}
      {confirmResetId && (() => {        const m = allEligible.find((r) => r.id === confirmResetId)
        const name = m ? [m.first_name, m.last_name].filter(Boolean).join(' ') || m.id : confirmResetId
        return (
          <div
            style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)',
              display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
              zIndex: 999, padding: '1rem',
            }}
            onClick={() => setConfirmResetId(null)}
          >
            <div
              style={{
                background: 'var(--card)', border: '1px solid var(--border)',
                borderRadius: '1rem', padding: '1.5rem', width: '100%', maxWidth: '22rem',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <p style={{ color: 'var(--text)', marginBottom: '0.5rem', fontWeight: 600 }}>
                Reset Face ID for {name}?
              </p>
              <p style={{ color: 'var(--muted)', fontSize: '0.875rem', marginBottom: '1.25rem' }}>
                They will be prompted to re-enrol on their next login.
              </p>
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button
                  onClick={() => setConfirmResetId(null)}
                  style={{
                    flex: 1, padding: '0.75rem', borderRadius: '0.5rem',
                    background: 'var(--bg2)', color: 'var(--muted)', border: '1px solid var(--border)',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => confirmResetFaceId(confirmResetId)}
                  style={{
                    flex: 1, padding: '0.75rem', borderRadius: '0.5rem',
                    background: 'var(--coral)', color: '#fff', border: 'none', fontWeight: 600,
                  }}
                >
                  Reset
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Absence reason modal */}
      {absenceTarget && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)',
            display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
            zIndex: 999, padding: '1rem',
          }}
          onClick={() => setAbsenceTarget(null)}
        >
          <div
            style={{
              background: 'var(--card)', border: '1px solid var(--border)',
              borderRadius: '1rem', padding: '1.5rem', width: '100%', maxWidth: '22rem',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <p style={{ color: 'var(--text)', fontWeight: 600, margin: '0 0 0.25rem' }}>Absence Reason</p>
            <p style={{ color: 'var(--muted)', fontSize: '0.875rem', margin: '0 0 1rem' }}>
              {[absenceTarget.first_name, absenceTarget.last_name].filter(Boolean).join(' ') || absenceTarget.id}
            </p>
            <textarea
              value={absenceInput}
              onChange={(e) => setAbsenceInput(e.target.value)}
              placeholder='Enter absence reason…'
              rows={3}
              style={{
                width: '100%', padding: '0.75rem', boxSizing: 'border-box',
                background: 'var(--bg2)', border: '1px solid var(--border)',
                borderRadius: '0.5rem', color: 'var(--text)', fontSize: '0.875rem',
                resize: 'vertical', marginBottom: '1rem',
              }}
            />
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button
                onClick={() => setAbsenceTarget(null)}
                style={{
                  flex: 1, padding: '0.75rem', borderRadius: '0.5rem',
                  background: 'var(--bg2)', color: 'var(--muted)', border: '1px solid var(--border)', cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={saveAbsenceNote}
                disabled={absenceSaving || !absenceInput.trim()}
                style={{
                  flex: 1, padding: '0.75rem', borderRadius: '0.5rem',
                  background: 'var(--accent)', color: '#fff', border: 'none',
                  fontWeight: 600, cursor: 'pointer',
                  opacity: (absenceSaving || !absenceInput.trim()) ? 0.5 : 1,
                }}
              >
                {absenceSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function cap(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

function Stat({ value, label, color = 'var(--text)' }) {
  return (
    <div>
      <p className='text-2xl font-bold m-0' style={{ color }}>{value}</p>
      <p className='text-[10px] uppercase tracking-widest m-0 mt-0.5' style={{ color: 'var(--muted)' }}>{label}</p>
    </div>
  )
}

function ListRow({ entry, tab, canManage, canResetFaceId, resetting, onManual, onResetFaceId, absenceNote, onAddNote, isRisky = false }) {
  const { member, record } = entry
  const name = [member.first_name, member.last_name].filter(Boolean).join(' ') || member.id
  const unit = member.bacenta_name || member.governorship_name || member.council_name || member.stream_name || '—'
  return (
    <div
      className='p-3 flex items-center justify-between gap-3'
      style={{ background: 'var(--card)', border: `1px solid ${isRisky ? '#f87060' : 'var(--border)'}`, borderRadius: 'var(--radius-btn)' }}
    >
      <div className='min-w-0'>
        <div className='flex items-center gap-1.5'>
          <p className='text-sm font-semibold m-0 truncate' style={{ color: 'var(--text)' }}>{name}</p>
          {isRisky && (
            <span
              title='Device fingerprint shared with another member — possible proxy check-in'
              className='text-[10px] font-bold px-1.5 py-0.5 leading-none'
              style={{ background: 'rgba(248,112,96,0.15)', color: 'var(--coral)', border: '1px solid rgba(248,112,96,0.3)', borderRadius: 'var(--radius-pill)', cursor: 'help', whiteSpace: 'nowrap' }}
            >
              ⚠ Device shared
            </span>
          )}
        </div>
        <p className='text-xs m-0 mt-0.5 truncate' style={{ color: 'var(--muted)' }}>{unit}</p>
      </div>
      <div className='text-right shrink-0 flex flex-col items-end gap-1'>
        {tab === 'defaulted' && (
          <>
            <Tag color='var(--amber)'>Pending</Tag>
            {absenceNote && (
              <span
                className='text-[10px] max-w-[120px] truncate block mt-0.5'
                style={{ color: 'var(--muted)' }}
                title={absenceNote}
              >
                {absenceNote}
              </span>
            )}
            {canManage && (
              <button
                onClick={onManual}
                className='text-xs px-3 py-1 cursor-pointer mt-1'
                style={{ background: 'transparent', color: 'var(--green)', border: '1.5px solid var(--green)', borderRadius: 'var(--radius-btn)' }}
              >
                Manually Check In
              </button>
            )}
            {onAddNote && (
              <button
                onClick={onAddNote}
                className='text-xs px-3 py-1 cursor-pointer mt-1'
                style={{ background: 'transparent', color: 'var(--purple)', border: '1.5px solid var(--purple)', borderRadius: 'var(--radius-btn)' }}
              >
                {absenceNote ? 'Edit Note' : 'Add Note'}
              </button>
            )}
          </>
        )}
        {tab !== 'defaulted' && record && (
          <>
            <p className='text-xs m-0' style={{ color: 'var(--muted)' }}>
              {format(new Date(record.checked_in_at), 'HH:mm')}
            </p>
            <div className='flex gap-1'>
              <Tag>{record.method}</Tag>
              {record.is_late && <Tag color='var(--amber)'>Late</Tag>}
            </div>
          </>
        )}
        {canResetFaceId && (
          <button
            onClick={onResetFaceId}
            disabled={resetting}
            className='text-xs px-3 py-1 cursor-pointer mt-1 disabled:opacity-50'
            style={{ background: 'transparent', color: 'var(--coral)', border: '1.5px solid var(--coral)', borderRadius: 'var(--radius-btn)' }}
          >
            {resetting ? 'Resetting…' : 'Reset Face ID'}
          </button>
        )}
      </div>
    </div>
  )
}

function Tag({ children, color = 'var(--text)' }) {
  return (
    <span
      className='text-[10px] px-2 py-0.5 uppercase font-bold'
      style={{ background: 'var(--bg2)', color, border: '1px solid var(--border)', borderRadius: 'var(--radius-pill)', letterSpacing: '0.05em' }}
    >
      {children}
    </span>
  )
}

function TimelineEntry({ entry, isLast }: { entry: { record: any; member: any }; isLast: boolean }) {
  const { record: r, member: m } = entry
  const name = [m.first_name, m.last_name].filter(Boolean).join(' ') || m.id
  const unit = m.bacenta_name || m.governorship_name || m.council_name || m.stream_name || '—'
  const checkInTime = format(new Date(r.checked_in_at), 'HH:mm')
  const checkOutTime = r.checked_out_at ? format(new Date(r.checked_out_at), 'HH:mm') : null
  return (
    <div
      className='flex items-start gap-3 px-4 py-3'
      style={{ borderBottom: isLast ? 'none' : '1px solid var(--border)' }}
    >
      <div className='flex flex-col items-end shrink-0' style={{ minWidth: 44 }}>
        <span className='text-xs font-bold tabular-nums' style={{ color: 'var(--text)' }}>{checkInTime}</span>
        {checkOutTime && (
          <span className='text-[10px] tabular-nums mt-0.5' style={{ color: 'var(--muted)' }}>→ {checkOutTime}</span>
        )}
      </div>
      <div className='flex-1 min-w-0'>
        <p className='text-sm font-semibold m-0 truncate' style={{ color: 'var(--text)' }}>{name}</p>
        <p className='text-xs m-0 mt-0.5 truncate' style={{ color: 'var(--muted)' }}>{unit}</p>
      </div>
      <div className='flex flex-col items-end gap-1 shrink-0'>
        <Tag>{r.method}</Tag>
        {r.is_late && <Tag color='var(--amber)'>Late</Tag>}
      </div>
    </div>
  )
}

function StatusPill({ status }) {
  const colors = {
    ACTIVE: { bg: 'rgba(46,203,143,0.12)', fg: 'var(--green)' },
    PAUSED: { bg: 'rgba(240,165,0,0.12)', fg: 'var(--amber)' },
    ENDED:  { bg: 'rgba(154,143,135,0.12)', fg: 'var(--muted)' },
  }[status] || { bg: 'var(--bg2)', fg: 'var(--text)' }
  return (
    <span
      className='text-[10px] px-2 py-0.5 font-bold uppercase'
      style={{ background: colors.bg, color: colors.fg, borderRadius: 'var(--radius-pill)', letterSpacing: '0.06em' }}
    >
      {status}
    </span>
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

function filterRows(rows, q) {
  const s = q.trim().toLowerCase()
  if (!s) return rows
  return rows.filter((b) => {
    const m = b.member
    return [m.first_name, m.last_name, m.bacenta_name, m.governorship_name, m.council_name, m.stream_name]
      .some((v) => (v || '').toLowerCase().includes(s))
  })
}

function csvRow(b, status) {
  const m = b.member
  const r = b.record
  return {
    Name: [m.first_name, m.last_name].filter(Boolean).join(' '),
    Role: (m.roles || [])[0] || '',
    Unit: m.bacenta_name || m.governorship_name || m.council_name || m.stream_name || '',
    Status: status,
    'Checked In At': r?.checked_in_at ? format(new Date(r.checked_in_at), 'yyyy-MM-dd HH:mm:ss') : '',
    'Checked Out At': r?.checked_out_at ? format(new Date(r.checked_out_at), 'yyyy-MM-dd HH:mm:ss') : '',
    'Auto Checked Out': r?.checked_out_at ? (r.auto_checked_out ? 'Yes' : 'No') : '',
    Method: r?.method || '',
    'Is Late': r ? (r.is_late ? 'Yes' : 'No') : '',
    'Geo Verified': r ? (r.geo_verified ? 'Yes' : 'No') : '',
  }
}
