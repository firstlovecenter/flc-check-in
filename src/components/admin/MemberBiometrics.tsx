import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import ScreenHeader from '../ScreenHeader'
import {
  listMembersForBiometricsAdmin, adminClearFaceDescriptor,
} from '../../utils/supabaseCheckins'
import { resolveCurrentMember, getAdminScopes } from '../../utils/membersApi'
import { getCurrentUser } from '../../utils/auth'
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

export default function MemberBiometrics() {
  const user = getCurrentUser()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [resetting, setResetting] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(25)

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      const member = await resolveCurrentMember(user)
      const scopes = getAdminScopes(member, user)
      const data = await listMembersForBiometricsAdmin(scopes)
      setRows(data)
    } catch (err: any) {
      setError(err.message || 'Could not load members')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { refresh() }, [user.userId])
  useRefreshSignal(() => { refresh() })

  async function handleReset(row: Row) {
    const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || row.id
    if (!window.confirm(`Reset Face ID for ${name}? They will be prompted to re-enrol on their next login.`)) return
    setResetting(row.id)
    try {
      await adminClearFaceDescriptor(row.id)
      setRows((prev) => prev.map((r) => r.id === row.id ? { ...r, has_face_id: false } : r))
    } catch (err: any) {
      setError(err.message || 'Could not reset Face ID')
    } finally {
      setResetting(null)
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (filter === 'enrolled' && !r.has_face_id) return false
      if (filter === 'not-enrolled' && r.has_face_id) return false
      if (!q) return true
      const name = [r.first_name, r.last_name].filter(Boolean).join(' ').toLowerCase()
      const unit = (r.bacenta_name || r.governorship_name || r.council_name || r.stream_name || '').toLowerCase()
      return name.includes(q) || unit.includes(q) || (r.email || '').toLowerCase().includes(q)
    })
  }, [rows, filter, search])

  const stats = useMemo(() => {
    const enrolled = rows.filter((r) => r.has_face_id).length
    return { total: rows.length, enrolled, notEnrolled: rows.length - enrolled }
  }, [rows])

  // Reset to page 1 whenever the filter, search, or page size changes —
  // otherwise the admin can be left on a page that no longer exists.
  useEffect(() => { setPage(1) }, [filter, search, pageSize])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const pageStart = (safePage - 1) * pageSize
  const pageRows = filtered.slice(pageStart, pageStart + pageSize)

  // Build a compact page-number list with ellipses for large totals.
  // Always show first, last, current ±1, and use '…' to bridge gaps.
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

  return (
    <div className='min-h-dvh' style={{ background: 'var(--bg)' }}>
      <ScreenHeader title='Member Biometrics' back={{ to: '/home', label: 'Home' }} />
      <main className='max-w-3xl mx-auto px-4 py-6 flex flex-col gap-4'>

        {/* Stats */}
        <div
          className='p-4 grid grid-cols-3 gap-3 text-center'
          style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-card)' }}
        >
          <Stat value={stats.total}       label='In Scope' />
          <Stat value={stats.enrolled}    label='Enrolled'  color='var(--green)' />
          <Stat value={stats.notEnrolled} label='Pending'   color='var(--amber)' />
        </div>

        {/* Filter + search */}
        <div className='flex flex-col gap-2'>
          <div className='flex gap-1'>
            {(['all', 'enrolled', 'not-enrolled'] as Filter[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className='text-xs px-3 py-1.5 cursor-pointer flex-1'
                style={{
                  background: filter === f ? 'var(--accent)' : 'transparent',
                  color: filter === f ? 'var(--bg)' : 'var(--text)',
                  border: '1px solid ' + (filter === f ? 'var(--accent)' : 'var(--border)'),
                  borderRadius: 'var(--radius-btn)',
                  fontWeight: 600,
                }}
              >
                {f === 'all' ? 'All' : f === 'enrolled' ? 'Enrolled' : 'Not enrolled'}
              </button>
            ))}
          </div>
          <input
            type='search'
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder='Search name, unit, or email…'
            className='input-field'
          />
        </div>

        {error && (
          <p className='text-sm px-3 py-2 text-center'
             style={{ color: 'var(--coral)', background: 'rgba(232,96,74,0.1)', border: '1px solid rgba(232,96,74,0.2)', borderRadius: 'var(--radius-btn)' }}>
            {error}
          </p>
        )}

        {loading && <p className='text-sm text-center' style={{ color: 'var(--muted)' }}>Loading members…</p>}

        {!loading && filtered.length === 0 && (
          <p className='text-sm text-center' style={{ color: 'var(--muted)' }}>
            {rows.length === 0 ? 'No members in your admin scopes yet.' : 'No matches.'}
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
                className='p-3 flex items-center justify-between gap-3 transition-opacity hover:opacity-90 active:scale-[0.99]'
                style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-btn)', textDecoration: 'none' }}
              >
                <RowAvatar pictureUrl={r.picture_url} initials={initials} />
                <div className='min-w-0 flex-1'>
                  <p className='text-sm font-semibold m-0 truncate' style={{ color: 'var(--text)' }}>{name}</p>
                  <p className='text-xs m-0 mt-0.5 truncate' style={{ color: 'var(--muted)' }}>{unit}</p>
                </div>
                <div className='shrink-0 flex items-center gap-2'>
                  {r.has_face_id ? (
                    <span className='text-[10px] px-2 py-0.5 uppercase font-bold'
                          style={{ background: 'rgba(46,203,143,0.12)', color: 'var(--green)', border: '1px solid rgba(46,203,143,0.3)', borderRadius: 'var(--radius-pill)', letterSpacing: '0.05em' }}>
                      Enrolled
                    </span>
                  ) : (
                    <span className='text-[10px] px-2 py-0.5 uppercase font-bold'
                          style={{ background: 'var(--bg2)', color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: 'var(--radius-pill)', letterSpacing: '0.05em' }}>
                      Not set
                    </span>
                  )}
                  {r.has_face_id && (
                    <button
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleReset(r) }}
                      disabled={resetting === r.id}
                      className='text-xs px-3 py-1 cursor-pointer disabled:opacity-50'
                      style={{ background: 'transparent', color: 'var(--coral)', border: '1.5px solid var(--coral)', borderRadius: 'var(--radius-btn)' }}
                    >
                      {resetting === r.id ? 'Resetting…' : 'Reset'}
                    </button>
                  )}
                </div>
              </Link>
            )
          })}
        </div>

        {/* Pagination controls — only render if there's more than one page or
            the admin might want to change the page size. */}
        {filtered.length > 0 && (
          <div
            className='flex items-center justify-between gap-3 flex-wrap text-xs'
            style={{ color: 'var(--muted)' }}
          >
            <div className='flex items-center gap-2'>
              <span>
                {pageStart + 1}–{Math.min(pageStart + pageSize, filtered.length)} of {filtered.length}
              </span>
              <label className='flex items-center gap-1'>
                <span>per page</span>
                <select
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                  className='cursor-pointer'
                  style={{
                    background: 'var(--bg2)',
                    color: 'var(--text)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-btn)',
                    padding: '4px 8px',
                  }}
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
                    <span key={`gap-${i}`} style={{ padding: '0 4px', color: 'var(--muted)' }}>…</span>
                  ) : (
                    <PageBtn key={p} active={p === safePage} onClick={() => setPage(p)}>{p}</PageBtn>
                  ),
                )}
                <PageBtn disabled={safePage === totalPages} onClick={() => setPage(safePage + 1)}>›</PageBtn>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
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
      className='cursor-pointer disabled:cursor-not-allowed disabled:opacity-40'
      style={{
        minWidth: 28,
        padding: '4px 8px',
        background: active ? 'var(--accent)' : 'var(--bg2)',
        color: active ? 'var(--bg)' : 'var(--text)',
        border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border)'),
        borderRadius: 'var(--radius-btn)',
        fontWeight: active ? 700 : 500,
      }}
    >
      {children}
    </button>
  )
}

function Stat({ value, label, color = 'var(--text)' }) {
  return (
    <div>
      <p className='text-2xl font-bold m-0' style={{ color }}>{value}</p>
      <p className='text-[10px] uppercase tracking-widest m-0 mt-0.5' style={{ color: 'var(--muted)' }}>{label}</p>
    </div>
  )
}

/** Small round avatar for member-list rows. picture_url is a URL string to
 *  an external image (Cloudinary etc.) — not image bytes. Falls back to a
 *  circular initials chip when the URL is missing or 404s. */
function RowAvatar({ pictureUrl, initials }: { pictureUrl: string | null; initials: string }) {
  const size = 40
  const common: React.CSSProperties = {
    width: size, height: size,
    borderRadius: '50%',
    flexShrink: 0,
    border: '1.5px solid var(--border)',
    background: 'var(--bg2)',
  }
  if (pictureUrl) {
    return (
      <img
        src={pictureUrl}
        alt={initials}
        width={size}
        height={size}
        loading='lazy'  // avoid fetching off-screen avatars on large lists
        style={{ ...common, objectFit: 'cover' }}
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
      />
    )
  }
  return (
    <div
      aria-label={initials}
      style={{
        ...common,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--muted)',
        fontSize: 13, fontWeight: 700,
      }}
    >{initials}</div>
  )
}
