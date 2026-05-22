import { useEffect, useRef, useState } from 'react'
import { searchMembersByName, memberToProfileRow } from '../../utils/membersApi'
import { addMemberToEventScope } from '../../utils/supabaseCheckins'
import { triggerRefresh } from '../../hooks/useRefreshSignal'

interface Props {
  eventId: string
  onClose: () => void
}

export default function AddMemberModal({ eventId, onClose }: Props) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [searching, setSearching] = useState(false)
  const [adding, setAdding] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    const trimmed = q.trim()
    if (trimmed.length < 2) { setResults([]); return }
    let cancelled = false
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const members = await searchMembersByName(trimmed, 15)
        if (!cancelled) setResults(members)
      } catch {
        if (!cancelled) setResults([])
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 300)
    return () => { cancelled = true; clearTimeout(t) }
  }, [q])

  async function handleAdd(member: any) {
    setError(null)
    setAdding(member.id)
    try {
      const profileRow = memberToProfileRow(member)
      await addMemberToEventScope(eventId, profileRow)
      setAdded((prev) => new Set([...prev, member.id]))
      triggerRefresh()
    } catch (err: any) {
      setError(err.message || 'Failed to add member')
    } finally {
      setAdding(null)
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className='fixed inset-0'
        style={{ background: 'rgba(0,0,0,0.6)', zIndex: 1100 }}
        onClick={onClose}
      />

      {/* Sheet */}
      <div
        className='fixed left-0 right-0 bottom-0 sm:inset-0 sm:flex sm:items-center sm:justify-center'
        style={{ zIndex: 1110, pointerEvents: 'none' }}
      >
        <div
          className='w-full sm:max-w-lg mx-auto flex flex-col'
          style={{
            background: 'var(--card)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-card) var(--radius-card) 0 0',
            boxShadow: 'var(--shadow-2)',
            maxHeight: '85dvh',
            pointerEvents: 'all',
          }}
        >
          {/* Header */}
          <div className='flex items-center justify-between px-4 py-3' style={{ borderBottom: '1px solid var(--border)' }}>
            <p className='text-sm font-bold m-0' style={{ color: 'var(--text)' }}>Add member to event</p>
            <button
              type='button'
              onClick={onClose}
              className='p-1.5 cursor-pointer'
              style={{ background: 'transparent', border: 'none', color: 'var(--muted)' }}
            >
              <svg viewBox='0 0 24 24' width='18' height='18' fill='currentColor'>
                <path d='M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z' />
              </svg>
            </button>
          </div>

          {/* Search input */}
          <div className='px-4 py-3' style={{ borderBottom: '1px solid var(--border)' }}>
            <input
              ref={inputRef}
              type='text'
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder='Search by first or last name…'
              className='w-full px-3 py-2 text-sm'
              style={{
                background: 'var(--bg2)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-btn)',
                color: 'var(--text)',
                outline: 'none',
              }}
            />
          </div>

          {/* Results */}
          <div className='flex-1 overflow-y-auto px-4 py-2'>
            {error && (
              <p className='text-xs py-2 text-center' style={{ color: 'var(--coral)' }}>{error}</p>
            )}
            {searching && (
              <p className='text-xs py-3 text-center' style={{ color: 'var(--muted)' }}>Searching…</p>
            )}
            {!searching && q.trim().length >= 2 && results.length === 0 && (
              <p className='text-xs py-3 text-center' style={{ color: 'var(--muted)' }}>No members found.</p>
            )}
            {!searching && q.trim().length < 2 && (
              <p className='text-xs py-3 text-center' style={{ color: 'var(--muted)' }}>Type at least 2 characters to search.</p>
            )}
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
              const isAdded = added.has(m.id)
              const isAdding = adding === m.id
              return (
                <div
                  key={m.id}
                  className='flex items-center justify-between gap-3 py-2.5'
                  style={{ borderBottom: '1px solid var(--border)' }}
                >
                  <div className='min-w-0'>
                    <p className='text-sm font-semibold m-0 truncate' style={{ color: 'var(--text)' }}>{name}</p>
                    <p className='text-xs m-0 mt-0.5 truncate' style={{ color: 'var(--muted)' }}>
                      {[bacenta, stream].filter(Boolean).join(' · ') || '—'}
                    </p>
                  </div>
                  <button
                    type='button'
                    disabled={isAdded || isAdding}
                    onClick={() => handleAdd(m)}
                    className='shrink-0 px-3 py-1.5 text-xs font-semibold cursor-pointer'
                    style={{
                      background: isAdded ? 'var(--green)' : 'var(--accent)',
                      color: 'var(--bg)',
                      border: 'none',
                      borderRadius: 'var(--radius-btn)',
                      opacity: isAdding ? 0.6 : 1,
                      minWidth: 60,
                    }}
                  >
                    {isAdded ? 'Added ✓' : isAdding ? '…' : 'Add'}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </>
  )
}
