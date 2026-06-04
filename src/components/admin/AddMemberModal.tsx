import { useEffect, useRef, useState } from 'react'
import { searchMembersByName, memberToProfileRow } from '../../utils/membersApi'
import { addMemberToEventScope } from '../../utils/supabaseCheckins'
import { triggerRefresh } from '../../hooks/useRefreshSignal'
import { Modal } from '../ui/modal'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'

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
    <Modal open onClose={onClose} variant='sheet' className='flex max-h-[85dvh] flex-col p-0'>
      <div className='flex items-center justify-between border-b border-border px-4 py-3'>
        <p className='m-0 text-sm font-bold text-foreground'>Add member to event</p>
        <button
          type='button'
          onClick={onClose}
          className='icon-btn cursor-pointer border-0 bg-transparent p-1.5 text-muted-foreground'
          aria-label='Close'
        >
          <svg viewBox='0 0 24 24' width='18' height='18' fill='currentColor'>
            <path d='M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z' />
          </svg>
        </button>
      </div>

      <div className='border-b border-border px-4 py-3'>
        <Input
          ref={inputRef}
          type='text'
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder='Search by first or last name…'
          className='text-sm'
        />
      </div>

      <div className='flex-1 overflow-y-auto px-4 py-2'>
        {error && <p className='py-2 text-center text-xs text-destructive'>{error}</p>}
        {searching && <p className='py-3 text-center text-xs text-muted-foreground'>Searching…</p>}
        {!searching && q.trim().length >= 2 && results.length === 0 && (
          <p className='py-3 text-center text-xs text-muted-foreground'>No members found.</p>
        )}
        {!searching && q.trim().length < 2 && (
          <p className='py-3 text-center text-xs text-muted-foreground'>Type at least 2 characters to search.</p>
        )}
        {results.map((m) => {
          const name = [m.firstName, m.lastName].filter(Boolean).join(' ') || m.id
          const bacenta = m.bacenta?.name || m.leadsBacenta?.[0]?.name || null
          const stream =
            m.leadsBacenta?.[0]?.governorship?.council?.stream?.name ||
            m.leadsGovernorship?.[0]?.council?.stream?.name ||
            m.leadsCouncil?.[0]?.stream?.name ||
            m.leadsStream?.[0]?.name ||
            null
          const isAdded = added.has(m.id)
          const isAdding = adding === m.id
          return (
            <div key={m.id} className='list-row flex items-center justify-between gap-3 border-b border-border py-2.5'>
              <div className='min-w-0'>
                <p className='m-0 truncate text-sm font-semibold text-foreground'>{name}</p>
                <p className='m-0 mt-0.5 truncate text-xs text-muted-foreground'>
                  {[bacenta, stream].filter(Boolean).join(' · ') || '—'}
                </p>
              </div>
              <Button
                type='button'
                size='sm'
                disabled={isAdded || isAdding}
                onClick={() => handleAdd(m)}
                className={cn('min-w-[60px]', isAdded && 'bg-success hover:bg-success')}
              >
                {isAdded ? 'Added ✓' : isAdding ? '…' : 'Add'}
              </Button>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}
