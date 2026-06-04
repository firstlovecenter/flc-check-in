import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import Spinner from '../Spinner'
import ScreenHeader from '../ScreenHeader'
import { Alert } from '../ui/alert'
import { Badge } from '../ui/badge'
import { cn } from '../../lib/utils'
import {
  listMembersForBiometricsAdmin, listAllMembersForBiometrics,
  getBiometricsTotals, adminClearFaceDescriptor, bulkUpsertMemberProfiles,
} from '../../utils/supabaseCheckins'
import {
  resolveCurrentMember, getAdminScopes, getAllLeadersAndAdmins,
  memberToProfileRow,
} from '../../utils/membersApi'
import { getCurrentUser } from '../../utils/auth'
import { SCOPE_LEVELS } from '../../types/app'
import { useRefreshSignal } from '../../hooks/useRefreshSignal'

type Row = {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  picture_url: string | null
  bacenta_name: string | null
  governorship_name: string | null
  council_name: string | null
  stream_name: string | null
  has_face_id: boolean
}

type Filter = 'all' | 'enrolled' | 'not-enrolled'

type SyncState =
  | { status: 'idle' }
  | { status: 'fetching'; fetched: number; kept: number }
  | { status: 'upserting'; kept: number }
  | { status: 'done'; fetched: number; upserted: number }
  | { status: 'error'; message: string }

export default function MemberBiometrics() {
  const user = getCurrentUser()
  const isSuperAdmin = !!user?.isSuperAdmin

  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [resetting, setResetting] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(25)
  const [search, setSearch] = useState('')
  const [dbTotals, setDbTotals] = useState<{ total: number; enrolled: number } | null>(null)
  const [syncState, setSyncState] = useState<SyncState>({ status: 'idle' })

  // ── Load biometrics data ──────────────────────────────────────────
  async function refresh(searchTerm?: string) {
    setLoading(true)
    setError(null)
    try {
      if (isSuperAdmin) {
        const [data, totals] = await Promise.all([
          listAllMembersForBiometrics(searchTerm),
          getBiometricsTotals(),
        ])
        setRows(data)
        setDbTotals(totals)
        return
      }
      // Collect scopes from JWT churchScopes (both isAdminFor* and leads* edges).
      const cs = user?.churchScopes as Record<string, { id: string; name?: string } | null | undefined> | undefined
      const seen = new Set<string>()
      const scopes: Array<{ level: string; id: string }> = []
      const push = (level: string, ref: { id: string } | null | undefined) => {
        if (!ref?.id) return
        const k = `${level}:${ref.id}`
        if (seen.has(k)) return
        seen.add(k)
        scopes.push({ level, id: ref.id })
      }
      for (const level of SCOPE_LEVELS) {
        const L = level.charAt(0).toUpperCase() + level.slice(1)
        push(level, cs?.[`isAdminFor${L}Of`])
        push(level, cs?.[`leads${L}Of`])
      }
      // Enrich with graph-side edges in case JWT is stale.
      try {
        const member = await resolveCurrentMember(user)
        for (const s of getAdminScopes(member, user)) push(s.level, { id: s.id })
      } catch { /* graph unreachable — JWT scopes are sufficient */ }

      if (!scopes.length) { setRows([]); setDbTotals({ total: 0, enrolled: 0 }); return }
      const [data, totals] = await Promise.all([
        listMembersForBiometricsAdmin(scopes),
        getBiometricsTotals(scopes),
      ])
      setRows(data)
      setDbTotals(totals)
    } catch (err: any) {
      setError(err.message || 'Could not load members')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { refresh() }, [user.userId])
  useRefreshSignal(() => { refresh() })

  // Debounced server-side search for superadmins
  useEffect(() => {
    if (!isSuperAdmin) return
    const trimmed = search.trim()
    let cancelled = false
    const t = setTimeout(() => {
      if (!cancelled) refresh(trimmed || undefined)
    }, 350)
    return () => { cancelled = true; clearTimeout(t) }
  }, [search, isSuperAdmin])

  const filtered = useMemo(() => {
    // Superadmin search is server-side; client-side filter still applies for
    // enrolled/not-enrolled tabs and local text on non-superadmin accounts.
    const q = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (filter === 'enrolled' && !r.has_face_id) return false
      if (filter === 'not-enrolled' && r.has_face_id) return false
      if (isSuperAdmin) return true // server already filtered by name
      if (!q) return true
      const name = [r.first_name, r.last_name].filter(Boolean).join(' ').toLowerCase()
      const unit = (r.bacenta_name || r.governorship_name || r.council_name || r.stream_name || '').toLowerCase()
      return name.includes(q) || unit.includes(q) || (r.email || '').toLowerCase().includes(q)
    })
  }, [rows, filter, search, isSuperAdmin])

  const stats = useMemo(() => {
    const total = dbTotals?.total ?? rows.length
    const enrolled = dbTotals?.enrolled ?? rows.filter((r) => r.has_face_id).length
    return { total, enrolled, notEnrolled: total - enrolled }
  }, [dbTotals, rows])

  useEffect(() => { setPage(1) }, [filter, search, pageSize])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const pageStart = (safePage - 1) * pageSize
  const pageRows = filtered.slice(pageStart, pageStart + pageSize)

  const pageItems: Array<number | 'gap'> = useMemo(() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1)
    const set = new Set<number>([1, totalPages, safePage, safePage - 1, safePage + 1])
    const sorted = [...set].filter((n) => n >= 1 && n <= totalPages).sort((a, b) => a - b)
    const out: Array<number | 'gap'> = []
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0 && sorted[i] - sorted[i - 1] > 1) out.push('gap')
      out.push(sorted[i])
    }
    return out
  }, [totalPages, safePage])

  // ── Reset Face ID ─────────────────────────────────────────────────
  async function handleReset(id: string, name: string) {
    if (!window.confirm(`Reset Face ID for ${name}? They will be prompted to re-enrol on their next login.`)) return
    setResetting(id)
    try {
      await adminClearFaceDescriptor(id)
      setRows((prev) => prev.map((r) => r.id === id ? { ...r, has_face_id: false } : r))
    } catch (err: any) {
      setError(err.message || 'Could not reset Face ID')
    } finally {
      setResetting(null)
    }
  }

  // ── Sync (superadmin only) ────────────────────────────────────────
  async function handleSync() {
    setSyncState({ status: 'fetching', fetched: 0, kept: 0 })
    try {
      const members = await getAllLeadersAndAdmins((fetched, kept) => {
        setSyncState({ status: 'fetching', fetched, kept })
      })
      setSyncState({ status: 'upserting', kept: members.length })
      const profileRows = members.map(memberToProfileRow)
      const upserted = await bulkUpsertMemberProfiles(profileRows)
      setSyncState({ status: 'done', fetched: profileRows.length, upserted: upserted.length })
      refresh(search.trim() || undefined)
    } catch (err: any) {
      setSyncState({ status: 'error', message: err?.message || 'Sync failed' })
    }
  }

  const syncRunning = syncState.status === 'fetching' || syncState.status === 'upserting'

  return (
    <div className='page-shell min-h-dvh'>
      <ScreenHeader title='Members' back={{ to: '/home', label: 'Home' }} />
      <main className='max-w-3xl mx-auto px-4 py-6 flex flex-col gap-4'>

        {/* Search + Sync toolbar */}
        <div className='flex gap-2'>
          <input
            type='search'
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={isSuperAdmin ? 'Search any member by name…' : 'Search name, unit, or email…'}
            autoFocus
            className='input-field flex-1 text-sm'
          />
          {isSuperAdmin && (
            <button
              type='button'
              onClick={handleSync}
              disabled={syncRunning}
              className='btn-pill btn-primary shrink-0 cursor-pointer whitespace-nowrap px-4 py-2.5 text-sm font-semibold disabled:opacity-50'
            >
              {syncState.status === 'fetching' && `Fetching… (${syncState.fetched})`}
              {syncState.status === 'upserting' && `Writing ${syncState.kept}…`}
              {!syncRunning && 'Sync members'}
            </button>
          )}
        </div>

        {/* Sync feedback */}
        {syncState.status === 'done' && (
          <Alert variant='success' className='text-center text-sm'>
            Synced <strong>{syncState.upserted}</strong> member{syncState.upserted === 1 ? '' : 's'}.
          </Alert>
        )}
        {syncState.status === 'error' && (
          <p className='text-sm px-3 py-2 text-center rounded-lg border border-destructive/20 bg-destructive/10 text-destructive'>
            {syncState.message}
          </p>
        )}

        {error && (
          <p className='text-sm px-3 py-2 text-center rounded-lg border border-destructive/20 bg-destructive/10 text-destructive'>
            {error}
          </p>
        )}

        {/* ── Stats + filter tabs ── */}
        <>
          <div
            className='p-4 grid grid-cols-3 gap-3 text-center surface-card'
          >
            <Stat value={stats.total}       label='In Scope' />
            <Stat value={stats.enrolled}    label='Enrolled'  className='text-success' />
            <Stat value={stats.notEnrolled} label='Pending'   className='text-warning' />
          </div>
          <div className='flex gap-1'>
            {(['all', 'enrolled', 'not-enrolled'] as Filter[]).map((f) => (
              <button
                key={f}
                type='button'
                onClick={() => setFilter(f)}
                className={cn(
                  'flex-1 cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors',
                  filter === f
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-transparent text-foreground',
                )}
              >
                {f === 'all' ? 'All' : f === 'enrolled' ? 'Enrolled' : 'Not enrolled'}
              </button>
            ))}
          </div>
        </>

        {/* ── Member list ── */}
        <>
          {loading && <Spinner />}
          {!loading && filtered.length === 0 && (
            <p className='text-sm text-center text-muted-foreground'>
              {rows.length === 0 ? 'No members found.' : 'No matches.'}
            </p>
          )}
          <div className='flex flex-col gap-2'>
            {pageRows.map((r) => {
              const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || r.id
              const unit = r.bacenta_name || r.governorship_name || r.council_name || r.stream_name || '—'
              const initials = [r.first_name?.[0], r.last_name?.[0]].filter(Boolean).join('').toUpperCase() || '?'
              return (
                <Link
                  key={r.id}
                  to={`/admin/members/${r.id}`}
                  className='surface-card flex items-center justify-between gap-3 p-3 no-underline transition-opacity hover:opacity-90 active:scale-[0.99]'
                >
                  <RowAvatar pictureUrl={r.picture_url} initials={initials} />
                  <div className='min-w-0 flex-1'>
                    <p className='text-sm font-semibold m-0 truncate text-foreground'>{name}</p>
                    <p className='text-xs m-0 mt-0.5 truncate text-muted-foreground'>{unit}</p>
                  </div>
                  <div className='shrink-0 flex items-center gap-2'>
                    <FaceIdBadge enrolled={r.has_face_id} />
                    {r.has_face_id && (
                      <ResetBtn
                        loading={resetting === r.id}
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleReset(r.id, name) }}
                      />
                    )}
                  </div>
                </Link>
              )
            })}
          </div>

          {filtered.length > pageSize && (
            <div className='flex items-center justify-between gap-3 flex-wrap text-xs text-muted-foreground'>
              <div className='flex items-center gap-2'>
                <span>
                  {pageStart + 1}–{Math.min(pageStart + pageSize, filtered.length)} of {filtered.length}
                </span>
                <label className='flex items-center gap-1'>
                  <span>per page</span>
                  <select
                    value={pageSize}
                    onChange={(e) => setPageSize(Number(e.target.value))}
                    className='input-field cursor-pointer px-2 py-1 text-xs'
                  >
                    {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
              </div>
              {totalPages > 1 && (
                <div className='flex items-center gap-1 flex-wrap'>
                  <PageBtn disabled={safePage === 1} onClick={() => setPage(safePage - 1)}>‹</PageBtn>
                  {pageItems.map((p, i) =>
                    p === 'gap' ? (
                      <span key={`gap-${i}`} className='px-1 text-muted-foreground'>…</span>
                    ) : (
                      <PageBtn key={p} active={p === safePage} onClick={() => setPage(p)}>{p}</PageBtn>
                    ),
                  )}
                  <PageBtn disabled={safePage === totalPages} onClick={() => setPage(safePage + 1)}>›</PageBtn>
                </div>
              )}
            </div>
          )}
        </>

      </main>
    </div>
  )
}

function FaceIdBadge({ enrolled }: { enrolled: boolean }) {
  return enrolled
    ? <Badge variant='success'>Enrolled</Badge>
    : <Badge variant='outline'>Not set</Badge>
}

function ResetBtn({ loading, onClick }: { loading: boolean; onClick: React.MouseEventHandler<HTMLButtonElement> }) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className='text-xs px-3 py-1 cursor-pointer disabled:opacity-50 rounded-lg border border-destructive text-destructive bg-transparent'
    >
      {loading ? 'Resetting…' : 'Reset'}
    </button>
  )
}

function PageBtn({ children, active, disabled, onClick }: {
  children: React.ReactNode
  active?: boolean
  disabled?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type='button'
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'min-w-7 cursor-pointer rounded-lg border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40',
        active
          ? 'border-primary bg-primary font-bold text-primary-foreground'
          : 'border-border bg-secondary font-medium text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function Stat({ value, label, className }: { value: number; label: string; className?: string }) {
  return (
    <div>
      <p className={cn('m-0 text-2xl font-bold text-foreground', className)}>{value}</p>
      <p className='m-0 mt-0.5 text-[10px] uppercase tracking-widest text-muted-foreground'>{label}</p>
    </div>
  )
}

function RowAvatar({ pictureUrl, initials }: { pictureUrl: string | null; initials: string }) {
  if (pictureUrl) {
    return (
      <div className='avatar h-10 w-10 shrink-0'>
        <img
          src={pictureUrl}
          alt={initials}
          width={40}
          height={40}
          loading='lazy'
          decoding='async'
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
        />
      </div>
    )
  }
  return (
    <div className='avatar h-10 w-10 shrink-0 bg-secondary' aria-label={initials}>
      <span className='avatar-fallback text-[13px]'>{initials}</span>
    </div>
  )
}
