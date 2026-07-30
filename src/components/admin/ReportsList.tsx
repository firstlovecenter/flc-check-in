import { useEffect, useState } from 'react'
import ScreenHeader from '../ScreenHeader'
import Papa from 'papaparse'
import { format } from 'date-fns'
import {
  listEventsForAdminScopes,
  listCheckedIn,
  getEvent,
  bulkUpsertMemberProfiles,
  listEventScopeMembersWithProfiles,
  listEventScopeMemberIds,
  listSpecialGroupMembers,
} from '../../utils/supabaseCheckins'
import { getCurrentUser } from '../../utils/auth'
import { useChurchFocus } from '../../contexts/ChurchFocusContext'
import { getMembersInScope, memberToProfileRow } from '../../utils/membersApi'
import { useRefreshSignal } from '../../hooks/useRefreshSignal'
import { PageShell, PageMain } from '../layout/PageShell'
import { CenterCard } from '../layout/CenterCard'
import { Card, CardContent } from '../ui/card'
import { Button } from '../ui/button'
import { Modal } from '../ui/modal'
import { Label } from '../ui/label'
import { Select } from '../ui/select'
import { EmptyState } from '../layout/EmptyState'
import { Input } from '../ui/input'

type ExportOptions = {
  includeSummary: boolean
  includeAttendanceSnapshot: boolean
  includePresentList: boolean
  includeAbsenteeList: boolean
  statusFilter: 'all' | 'present' | 'absent'
  methodFilter: 'all' | 'QR' | 'PIN' | 'MANUAL'
  geoFilter: 'all' | 'verified_only' | 'unverified_only'
  unitContains: string
}

type ExportPreset = {
  id: string
  label: string
  options: ExportOptions
}

const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  includeSummary: true,
  includeAttendanceSnapshot: true,
  includePresentList: true,
  includeAbsenteeList: true,
  statusFilter: 'all',
  methodFilter: 'all',
  geoFilter: 'all',
  unitContains: '',
}

const EXPORT_PRESETS: ExportPreset[] = [
  {
    id: 'executive_full',
    label: 'Executive Full',
    options: {
      includeSummary: true,
      includeAttendanceSnapshot: true,
      includePresentList: true,
      includeAbsenteeList: true,
      statusFilter: 'all',
      methodFilter: 'all',
      geoFilter: 'all',
      unitContains: '',
    },
  },
  {
    id: 'absentee_followup',
    label: 'Absentee Follow-up',
    options: {
      includeSummary: true,
      includeAttendanceSnapshot: true,
      includePresentList: false,
      includeAbsenteeList: true,
      statusFilter: 'absent',
      methodFilter: 'all',
      geoFilter: 'all',
      unitContains: '',
    },
  },
]

function optionsEqual(a: ExportOptions, b: ExportOptions) {
  const normUnitA = (a.unitContains || '').trim().toLowerCase()
  const normUnitB = (b.unitContains || '').trim().toLowerCase()
  return a.includeSummary === b.includeSummary
    && a.includeAttendanceSnapshot === b.includeAttendanceSnapshot
    && a.includePresentList === b.includePresentList
    && a.includeAbsenteeList === b.includeAbsenteeList
    && a.statusFilter === b.statusFilter
    && a.methodFilter === b.methodFilter
    && a.geoFilter === b.geoFilter
    && normUnitA === normUnitB
}

function detectPresetId(options: ExportOptions): string {
  const match = EXPORT_PRESETS.find((p) => optionsEqual(options, p.options))
  return match?.id || 'custom'
}

export default function ReportsList() {
  const user = getCurrentUser()
  const { focusedScope } = useChurchFocus()
  const [events, setEvents] = useState<any[]>([])
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [exportEventId, setExportEventId] = useState<string | null>(null)
  const [isExporting, setIsExporting] = useState(false)
  const [exportOptions, setExportOptions] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS)
  const [activePresetId, setActivePresetId] = useState<string>('executive_full')
  const [refreshKey, setRefreshKey] = useState(0)
  useRefreshSignal(() => setRefreshKey((k) => k + 1))

  function patchExportOptions(patch: Partial<ExportOptions>) {
    setExportOptions((prev) => {
      const next = { ...prev, ...patch }
      setActivePresetId(detectPresetId(next))
      return next
    })
  }

  function applyPreset(presetId: string) {
    const preset = EXPORT_PRESETS.find((p) => p.id === presetId)
    if (!preset) return
    setActivePresetId(presetId)
    setExportOptions(preset.options)
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // Scope from the ACTIVE HAT, falling back to the user's own level only
        // when they are browsing "All roles".
        //
        // This used to read `user.level` and `user[level].id` directly — the
        // JWT's single "level" field, which is one value for someone who may
        // hold several roles. So Reports silently reported on whichever role the
        // JWT happened to name, regardless of which one the user had selected.
        const scopes = focusedScope?.level && focusedScope?.id
          ? [{ level: focusedScope.level, id: focusedScope.id }]
          : (() => {
              const ownLevel = user?.level
              const ownId = ownLevel ? (user as any)[ownLevel]?.id : null
              return ownLevel && ownId ? [{ level: ownLevel, id: ownId }] : []
            })()
        const evs = await listEventsForAdminScopes(scopes, { user })
        if (!cancelled) setEvents(evs)
      } catch (err: any) {
        if (!cancelled) setError(err.message)
      }
    })()
    return () => { cancelled = true }
  }, [user?.userId, refreshKey, focusedScope?.level, focusedScope?.id])

  async function handleDownload(eventId: string, options: ExportOptions) {
    try {
      if (isExporting) return
      setIsExporting(true)
      const evt = await getEvent(eventId)
      let rows: any[] = []
      const [snapIds, snapshotRows] = await Promise.all([
        listEventScopeMemberIds(eventId),
        listEventScopeMembersWithProfiles(eventId),
      ])

      if (evt.scope_level === 'special_group') {
        // Snapshot is authoritative for historical exports.
        // Fall back to live group membership only for legacy events with no snapshot.
        const members = await listSpecialGroupMembers(evt.scope_church_id)
        const snapById = new Map((snapshotRows || []).map((r: any) => [r.id, r]))
        const liveById = new Map((members || []).map((m) => [m.member_id, m]))
        const baseIds = snapIds.length > 0 ? snapIds : members.map((m) => m.member_id)
        rows = baseIds.map((memberId: string) => {
          const prof = snapById.get(memberId)
          if (prof) return prof
          const m = liveById.get(memberId)
          if (m) {
            return {
              id: m.member_id,
              first_name: (m.member_name || '').split(' ')[0] || m.member_name || m.member_id,
              last_name: (m.member_name || '').split(' ').slice(1).join(' '),
              roles: [],
              bacenta_name: '',
              governorship_name: '',
              council_name: '',
              stream_name: '',
            }
          }
          return {
            id: memberId,
            first_name: memberId,
            last_name: '',
            roles: [],
            bacenta_name: '',
            governorship_name: '',
            council_name: '',
            stream_name: '',
          }
        })
      } else {
        if (snapIds.length > 0) {
          const byId = new Map((snapshotRows || []).map((r: any) => [r.id, r]))
          let graphById = new Map<string, any>()
          const missingIds = snapIds.filter((id: string) => !byId.has(id))
          if (missingIds.length > 0) {
            try {
              const graphMembers = await getMembersInScope({ level: evt.scope_level, churchId: evt.scope_church_id })
              graphById = new Map((graphMembers || []).map((m: any) => [m.id, memberToProfileRow(m)]))
            } catch {
              // If graph is unavailable, keep export resilient with minimal member rows.
            }
          }
          rows = snapIds.map((id: string) => (
            byId.get(id)
            || graphById.get(id)
            || {
              id,
              first_name: id,
              last_name: '',
              roles: [],
              bacenta_name: '',
              governorship_name: '',
              council_name: '',
              stream_name: '',
            }
          ))
        } else {
          const members = await getMembersInScope({ level: evt.scope_level, churchId: evt.scope_church_id })
          rows = members.map(memberToProfileRow)
        }
      }

      // Backfill profiles from the full resolved snapshot, before the role
      // filter below narrows `rows` — members outside allowed_roles still
      // get their member_profiles row kept fresh, matching prior behavior.
      const realProfileRows = rows.filter((r) => {
        const fn = (r.first_name || '').trim()
        return fn !== '' && fn !== r.id
      })
      if (realProfileRows.length > 0) {
        await bulkUpsertMemberProfiles(realProfileRows)
      }

      // Same population rule as get_event_dashboard_stats: the snapshot is
      // filtered by allowed_roles so the export's Present/Absent counts
      // match the dashboard. Special-group membership IS eligibility — no
      // role filter.
      if (evt.scope_level !== 'special_group') {
        const allowedRoles = new Set(evt.allowed_roles || [])
        rows = rows.filter((m) => (m.roles || []).some((role: string) => allowedRoles.has(role)))
      }

      const recs = await listCheckedIn(eventId)
      const recordByMember = new Map(recs.map((r) => [r.member_id, r]))

      const memberRows = rows.map((m) => {
        const r = recordByMember.get(m.id)
        const fullName = [m.first_name, m.last_name].filter(Boolean).join(' ') || m.id
        const unit = m.bacenta_name || m.governorship_name || m.council_name || m.stream_name || ''
        const status = r ? 'Present' : 'Absent'
        return {
          name: fullName,
          role: (m.roles || [])[0] || '',
          unit,
          status,
          checkedInAt: r?.checked_in_at ? format(new Date(r.checked_in_at), 'yyyy-MM-dd HH:mm:ss') : '',
          method: r?.method || '',
          geoVerified: r ? (r.geo_verified ? 'Yes' : 'No') : '',
        }
      })

      const filteredRows = memberRows.filter((r) => {
        if (options.statusFilter === 'present' && r.status !== 'Present') return false
        if (options.statusFilter === 'absent' && r.status !== 'Absent') return false
        if (options.methodFilter !== 'all' && r.method !== options.methodFilter) return false
        if (options.geoFilter === 'verified_only' && r.geoVerified !== 'Yes') return false
        if (options.geoFilter === 'unverified_only' && (r.status === 'Absent' || r.geoVerified !== 'No')) return false
        if (options.unitContains.trim()) {
          const needle = options.unitContains.trim().toLowerCase()
          if (!(r.unit || '').toLowerCase().includes(needle)) return false
        }
        return true
      })

      const attended = filteredRows.filter((r) => r.status === 'Present')
      const absentees = filteredRows.filter((r) => r.status === 'Absent')
      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss')

      const csvRows: (string | number)[][] = []

      if (options.includeSummary) {
        csvRows.push(
          ['Executive Summary'],
          ['Generated At', now],
          ['Event Name', evt.name || ''],
          ['Scope', `${evt.scope_level || ''} - ${evt.scope_church_name || ''}`],
          ['Venue', evt.venue_name || ''],
          ['Start Time', evt.starts_at ? format(new Date(evt.starts_at), 'yyyy-MM-dd HH:mm:ss') : ''],
          ['End Time', evt.ends_at ? format(new Date(evt.ends_at), 'yyyy-MM-dd HH:mm:ss') : ''],
          ['Criteria', [
            `status=${options.statusFilter}`,
            `method=${options.methodFilter}`,
            `geo=${options.geoFilter}`,
            `unit~${options.unitContains || 'any'}`,
          ].join('; ')],
          [],
        )
      }

      if (options.includeAttendanceSnapshot) {
        csvRows.push(
          ['Attendance Snapshot'],
          ['Present', attended.length],
          ['Absent', absentees.length],
          [],
        )
      }

      if (options.includePresentList) {
        csvRows.push(
          ['Present List'],
          ['#', 'Name', 'Role', 'Unit', 'Status', 'Checked In At', 'Method', 'Geo Verified'],
          ...attended.map((r, idx) => [
            idx + 1,
            r.name,
            r.role,
            r.unit,
            r.status,
            r.checkedInAt,
            r.method,
            r.geoVerified,
          ]),
          [],
        )
      }

      if (options.includeAbsenteeList) {
        csvRows.push(
          ['Absentees'],
          ['#', 'Name', 'Role', 'Unit'],
          ...absentees.map((r, idx) => [idx + 1, r.name, r.role, r.unit]),
        )
      }

      const csv = Papa.unparse(csvRows)
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const safeName = evt.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
      a.href = url
      a.download = `${safeName}-${format(new Date(evt.starts_at), 'yyyy-MM-dd')}.csv`
      a.click()
      URL.revokeObjectURL(url)
      setExportEventId(null)
    } catch (err: any) {
      alert(err.message || 'Export failed')
    } finally {
      setIsExporting(false)
    }
  }

  function openExportOptions(eventId: string) {
    setExportEventId(eventId)
    setExportOptions(DEFAULT_EXPORT_OPTIONS)
    setActivePresetId('executive_full')
  }

  if (error) {
    return (
      <CenterCard>
        <p className='text-destructive'>{error}</p>
      </CenterCard>
    )
  }

  const filteredEvents = events.filter((evt) => {
    const s = search.trim().toLowerCase()
    if (!s) return true
    return [evt.name, evt.scope_church_name, evt.scope_level, evt.status]
      .some((v) => (v || '').toLowerCase().includes(s))
  })

  return (
    <PageShell>
      <ScreenHeader
        title='Reports'
        right={<span className='text-xs text-muted-foreground'>{filteredEvents.length}</span>}
      />
      <PageMain className='flex flex-col gap-3'>
        <input
          type='search'
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder='Search events…'
          className='input-field'
        />
        {filteredEvents.length === 0 && (
          <EmptyState
            title={search ? 'No matches' : 'No events yet'}
            description={search ? 'Try a different search term.' : 'Reports will appear when events exist in your scope.'}
          />
        )}
        <div className='grid grid-cols-1 gap-3 md:grid-cols-2'>
          {filteredEvents.map((evt) => (
            <Card key={evt.id}>
              <CardContent className='p-0'>
                <div className='flex items-center justify-between gap-3 p-4'>
                  <button
                    type='button'
                    onClick={() => setExpanded(expanded === evt.id ? null : evt.id)}
                    className='min-w-0 flex-1 cursor-pointer border-0 bg-transparent p-0 text-left text-foreground'
                  >
                    <p className='m-0 truncate text-sm font-semibold'>{evt.name}</p>
                    <p className='m-0 mt-0.5 truncate text-xs text-muted-foreground'>
                      {evt.scope_level} · {evt.scope_church_name} · {evt.status}
                    </p>
                  </button>
                  <Button type='button' variant='outline' size='sm' onClick={() => openExportOptions(evt.id)}>
                    Download CSV
                  </Button>
                </div>
                {expanded === evt.id && (
                  <div className='space-y-1 px-4 pb-4 text-xs text-muted-foreground'>
                    <p>Starts: {format(new Date(evt.starts_at), 'PP HH:mm')}</p>
                    <p>Ends: {format(new Date(evt.ends_at), 'PP HH:mm')}</p>
                    <p>Methods: {(evt.allowed_check_in_methods || []).join(', ')}</p>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </PageMain>

      <Modal
        open={!!exportEventId}
        onClose={() => !isExporting && setExportEventId(null)}
        variant='sheet'
        className='flex max-h-[85dvh] flex-col p-0'
      >
        <div className='flex items-center justify-between border-b border-border px-4 py-3'>
          <p className='m-0 text-sm font-bold text-foreground'>Export Options</p>
          <button
            type='button'
            onClick={() => setExportEventId(null)}
            className='icon-btn cursor-pointer border-0 bg-transparent p-1.5 text-muted-foreground'
            aria-label='Close'
            disabled={isExporting}
          >
            <svg viewBox='0 0 24 24' width='18' height='18' fill='currentColor'>
              <path d='M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z' />
            </svg>
          </button>
        </div>

        <div className='flex-1 overflow-y-auto px-4 py-4'>
          <div className='flex flex-col gap-2'>
            <Label className='section-heading'>One-click Presets</Label>
            <div className='flex flex-wrap gap-2'>
              {EXPORT_PRESETS.map((preset) => (
                <Button
                  key={preset.id}
                  type='button'
                  variant={activePresetId === preset.id ? 'default' : 'outline'}
                  onClick={() => applyPreset(preset.id)}
                >
                  {preset.label}
                </Button>
              ))}
              <span
                className={activePresetId === 'custom'
                  ? 'inline-flex min-h-11 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground'
                  : 'inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm font-medium text-muted-foreground'}
              >
                Custom
              </span>
            </div>
          </div>

          <div className='flex flex-col gap-2'>
            <Label className='section-heading'>Include Sections</Label>
            <label className='check-row'>
              <input
                type='checkbox'
                checked={exportOptions.includeSummary}
                onChange={(e) => patchExportOptions({ includeSummary: e.target.checked })}
              />
              Executive summary
            </label>
            <label className='check-row'>
              <input
                type='checkbox'
                checked={exportOptions.includeAttendanceSnapshot}
                onChange={(e) => patchExportOptions({ includeAttendanceSnapshot: e.target.checked })}
              />
              Attendance snapshot
            </label>
            <label className='check-row'>
              <input
                type='checkbox'
                checked={exportOptions.includePresentList}
                onChange={(e) => patchExportOptions({ includePresentList: e.target.checked })}
              />
              Present list
            </label>
            <label className='check-row'>
              <input
                type='checkbox'
                checked={exportOptions.includeAbsenteeList}
                onChange={(e) => patchExportOptions({ includeAbsenteeList: e.target.checked })}
              />
              Absentee list
            </label>
          </div>

          <div className='mt-4 flex flex-col gap-2'>
            <Label className='section-heading'>Criteria</Label>
            <Label>Status</Label>
            <Select
              value={exportOptions.statusFilter}
              onChange={(e) => patchExportOptions({ statusFilter: e.target.value as ExportOptions['statusFilter'] })}
            >
              <option value='all'>All</option>
              <option value='present'>Present</option>
              <option value='absent'>Absent</option>
            </Select>

            <Label>Method</Label>
            <Select
              value={exportOptions.methodFilter}
              onChange={(e) => patchExportOptions({ methodFilter: e.target.value as ExportOptions['methodFilter'] })}
            >
              <option value='all'>All</option>
              <option value='QR'>QR</option>
              <option value='PIN'>PIN</option>
              <option value='MANUAL'>Manual</option>
            </Select>

            <Label>Geo verification</Label>
            <Select
              value={exportOptions.geoFilter}
              onChange={(e) => patchExportOptions({ geoFilter: e.target.value as ExportOptions['geoFilter'] })}
            >
              <option value='all'>All</option>
              <option value='verified_only'>Verified only</option>
              <option value='unverified_only'>Unverified only</option>
            </Select>

            <Label>Unit contains</Label>
            <Input
              value={exportOptions.unitContains}
              onChange={(e) => patchExportOptions({ unitContains: e.target.value })}
              placeholder='e.g. Adenta, Achimota'
            />
          </div>
        </div>

        <div className='flex items-center justify-end gap-2 border-t border-border px-4 py-3'>
          <Button type='button' variant='outline' onClick={() => setExportEventId(null)} disabled={isExporting}>Cancel</Button>
          <Button
            type='button'
            onClick={() => exportEventId && handleDownload(exportEventId, exportOptions)}
            disabled={isExporting || (!exportOptions.includeSummary && !exportOptions.includeAttendanceSnapshot && !exportOptions.includePresentList && !exportOptions.includeAbsenteeList)}
          >
            {isExporting ? 'Exporting…' : 'Export'}
          </Button>
        </div>
      </Modal>
    </PageShell>
  )
}
