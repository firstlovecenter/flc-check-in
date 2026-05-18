import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import ScreenHeader from '../../components/ScreenHeader'
import { searchMembersByName } from '../../utils/membersApi'

export default function MemberSearchScreen() {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    const trimmed = q.trim()
    if (trimmed.length < 2) { setResults([]); return }
    let cancelled = false
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const members = await searchMembersByName(trimmed, 25)
        if (!cancelled) setResults(members)
      } catch {
        if (!cancelled) setResults([])
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 300)
    return () => { cancelled = true; clearTimeout(t) }
  }, [q])

  return (
    <div className='min-h-dvh' style={{ background: 'var(--bg)' }}>
      <ScreenHeader title='Member Search' back={{ to: '/home', label: 'Home' }} />

      <main className='max-w-2xl mx-auto px-4 sm:px-6 py-5 flex flex-col gap-4'>
        <input
          type='text'
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder='Search by first or last name…'
          autoFocus
          className='w-full px-3 py-2.5 text-sm'
          style={{
            background: 'var(--card)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-btn)',
            color: 'var(--text)',
            outline: 'none',
          }}
        />

        {searching && (
          <p className='text-sm text-center' style={{ color: 'var(--muted)' }}>Searching…</p>
        )}
        {!searching && q.trim().length >= 2 && results.length === 0 && (
          <p className='text-sm text-center' style={{ color: 'var(--muted)' }}>No members found.</p>
        )}

        {results.length > 0 && (
          <div className='flex flex-col gap-2'>
            {results.map((m) => {
              const name = [m.firstName, m.lastName].filter(Boolean).join(' ') || m.id
              const bacenta = m.bacenta?.name || m.leadsBacenta?.[0]?.name || null
              const stream = (
                m.leadsBacenta?.[0]?.governorship?.council?.stream?.name ||
                m.leadsGovernorship?.[0]?.council?.stream?.name ||
                m.leadsCouncil?.[0]?.stream?.name ||
                m.leadsStream?.[0]?.name ||
                null
              )
              const roles: string[] = []
              if (m.leadsBacenta?.length)      roles.push('Bacenta Leader')
              if (m.leadsGovernorship?.length)  roles.push('Governorship Leader')
              if (m.leadsCouncil?.length)       roles.push('Council Leader')
              if (m.leadsStream?.length)        roles.push('Stream Leader')
              if (m.leadsCampus?.length)        roles.push('Campus Leader')
              if (m.leadsOversight?.length)     roles.push('Oversight Leader')
              if (m.leadsDenomination?.length)  roles.push('Denomination Leader')
              if (m.isAdminForGovernorship?.length) roles.push('Governorship Admin')
              if (m.isAdminForCouncil?.length)      roles.push('Council Admin')
              if (m.isAdminForStream?.length)       roles.push('Stream Admin')
              if (m.isAdminForCampus?.length)       roles.push('Campus Admin')
              if (m.isAdminForOversight?.length)    roles.push('Oversight Admin')
              if (m.isAdminForDenomination?.length) roles.push('Denomination Admin')

              return (
                <Link
                  key={m.id}
                  to={`/admin/members/${m.id}`}
                  className='flex items-center justify-between gap-3 px-4 py-3'
                  style={{
                    background: 'var(--card)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-btn)',
                    textDecoration: 'none',
                    boxShadow: 'var(--shadow-1)',
                  }}
                >
                  <div className='min-w-0 flex items-center gap-3'>
                    {m.pictureUrl ? (
                      <img
                        src={m.pictureUrl}
                        alt={name}
                        width={36}
                        height={36}
                        loading='lazy'
                        decoding='async'
                        style={{ borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
                      />
                    ) : (
                      <div
                        style={{
                          width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                          background: 'var(--accent)', color: 'var(--bg)',
                          fontSize: 14, fontWeight: 700,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        {(m.firstName?.[0] || '?').toUpperCase()}
                      </div>
                    )}
                    <div className='min-w-0'>
                      <p className='text-sm font-semibold m-0 truncate' style={{ color: 'var(--text)' }}>{name}</p>
                      <p className='text-xs m-0 mt-0.5 truncate' style={{ color: 'var(--muted)' }}>
                        {[roles[0], bacenta, stream].filter(Boolean).join(' · ') || '—'}
                      </p>
                    </div>
                  </div>
                  <svg viewBox='0 0 24 24' width='16' height='16' fill='currentColor' style={{ color: 'var(--muted)', flexShrink: 0 }}>
                    <path d='M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z' />
                  </svg>
                </Link>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
