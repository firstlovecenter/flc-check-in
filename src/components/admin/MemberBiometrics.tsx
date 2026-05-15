import { useEffect, useMemo, useState } from 'react'
import ScreenHeader from '../ScreenHeader'
import {
  listMembersForBiometricsAdmin, adminClearFaceDescriptor,
} from '../../utils/supabaseCheckins'
import { resolveCurrentMember, getAdminScopes } from '../../utils/membersApi'
import { getCurrentUser } from '../../utils/auth'

type Row = {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
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
          {filtered.map((r) => {
            const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || r.id
            const unit = r.bacenta_name || r.governorship_name || r.council_name || r.stream_name || '—'
            return (
              <div
                key={r.id}
                className='p-3 flex items-center justify-between gap-3'
                style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-btn)' }}
              >
                <div className='min-w-0'>
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
                      onClick={() => handleReset(r)}
                      disabled={resetting === r.id}
                      className='text-xs px-3 py-1 cursor-pointer disabled:opacity-50'
                      style={{ background: 'transparent', color: 'var(--coral)', border: '1.5px solid var(--coral)', borderRadius: 'var(--radius-btn)' }}
                    >
                      {resetting === r.id ? 'Resetting…' : 'Reset'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </main>
    </div>
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
