import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import ScreenHeader from '../../components/ScreenHeader'
import Spinner from '../../components/Spinner'
import { PageShell, PageMain } from '../../components/layout/PageShell'
import { Modal } from '../../components/ui/modal'
import { Button } from '../../components/ui/button'
import RequireAdmin from '../../components/admin/RequireAdmin'
import { getCurrentUser } from '../../utils/auth'
import {
  searchMemberProfiles, listMemberProfilesPaginated,
  listSpecialGroups, addMembersToSpecialGroup,
  type SpecialGroup,
} from '../../utils/supabaseCheckins'

const PAGE_SIZE = 25

export default function MemberSearchScreen() {
  return (
    <RequireAdmin>
      <MemberSearch />
    </RequireAdmin>
  )
}

function MemberSearch() {
  const user = getCurrentUser()
  const isSuperAdmin = !!user?.isSuperAdmin
  const canSyncMembers = !!user?.level && user.level !== 'bacenta'
  const navigate = useNavigate()

  const [query, setQuery]             = useState('')
  const [page, setPage]               = useState(0)
  const [members, setMembers]         = useState<any[]>([])
  const [total, setTotal]             = useState(0)
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState<string | null>(null)

  // Add-to-group
  const [groups, setGroups]           = useState<SpecialGroup[]>([])
  const [addTarget, setAddTarget]     = useState<any | null>(null)
  const [adding, setAdding]           = useState(false)
  const [addError, setAddError]       = useState<string | null>(null)
  const [addedGroupId, setAddedGroupId] = useState<string | null>(null)

  const isSearchMode = query.trim().length >= 2

  // Reset page when switching search mode
  const prevSearchMode = useRef(isSearchMode)
  useEffect(() => {
    if (prevSearchMode.current && !isSearchMode) setPage(0)
    prevSearchMode.current = isSearchMode
  })

  // Load paginated list
  useEffect(() => {
    if (isSearchMode) return
    let cancelled = false
    setLoading(true)
    setError(null)
    listMemberProfilesPaginated(page, PAGE_SIZE)
      .then(({ data, count }) => {
        if (!cancelled) { setMembers(data); setTotal(count) }
      })
      .catch((err) => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [page, isSearchMode])

  // Search
  useEffect(() => {
    if (!isSearchMode) { setSearchResults([]); return }
    let cancelled = false
    const timer = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const data = await searchMemberProfiles(query.trim(), 100)
        if (!cancelled) setSearchResults(data)
      } catch (err: any) {
        if (!cancelled) setError(err.message || 'Search failed')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 300)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [query, isSearchMode])

  // Load groups once for superAdmin
  useEffect(() => {
    if (!isSuperAdmin) return
    listSpecialGroups().then(setGroups).catch(() => {})
  }, [isSuperAdmin])

  async function handleAddToGroup(groupId: string) {
    if (!addTarget) return
    setAdding(true)
    setAddError(null)
    const name = [addTarget.title, addTarget.first_name, addTarget.last_name]
      .filter(Boolean).join(' ') || addTarget.email || addTarget.id
    try {
      await addMembersToSpecialGroup(groupId, [{ id: addTarget.id, name }])
      setAddedGroupId(groupId)
      setTimeout(() => {
        setAddTarget(null)
        setAddedGroupId(null)
      }, 800)
    } catch (err: any) {
      setAddError(err.message || 'Failed to add to group')
    } finally {
      setAdding(false)
    }
  }

  const displayList = isSearchMode ? searchResults : members
  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <PageShell>
      <ScreenHeader title='Members' />
      <PageMain className='flex flex-col gap-4'>
        {canSyncMembers && (
          <button
            type='button'
            onClick={() => navigate('/admin/sync-members')}
            className='btn-pill btn-secondary self-end px-4 py-2 text-sm cursor-pointer'
          >
            Sync Members
          </button>
        )}
        <input
          type='search'
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='Search by name or email…'
          className='input-field'
        />

        {loading && <Spinner />}
        {error && <p className='text-sm text-destructive'>{error}</p>}

        {!loading && isSearchMode && searchResults.length === 0 && (
          <p className='mt-4 text-center text-sm text-muted-foreground'>No members found.</p>
        )}

        {!loading && !isSearchMode && members.length === 0 && (
          <p className='mt-4 text-center text-sm text-muted-foreground'>No members yet.</p>
        )}

        <div className='flex flex-col gap-2'>
          {displayList.map((m) => (
            <MemberRow
              key={m.id}
              member={m}
              isSuperAdmin={isSuperAdmin}
              onAddToGroup={() => setAddTarget(m)}
            />
          ))}
        </div>

        {/* Pagination */}
        {!isSearchMode && !loading && totalPages > 1 && (
          <div className='flex items-center justify-between gap-3 pt-1'>
            <button
              type='button'
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              className='btn-pill btn-secondary px-4 py-2 text-sm disabled:opacity-40 cursor-pointer'
            >
              ← Prev
            </button>
            <span className='text-xs text-muted-foreground'>
              {page + 1} / {totalPages}
            </span>
            <button
              type='button'
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              className='btn-pill btn-secondary px-4 py-2 text-sm disabled:opacity-40 cursor-pointer'
            >
              Next →
            </button>
          </div>
        )}

        {!isSearchMode && !loading && total > 0 && totalPages <= 1 && (
          <p className='text-center text-xs text-muted-foreground'>{total} members</p>
        )}
      </PageMain>

      {/* Add to group modal (superAdmin only) */}
      {isSuperAdmin && (
        <Modal
          open={!!addTarget}
          onClose={() => { setAddTarget(null); setAddError(null); setAddedGroupId(null) }}
          variant='sheet'
        >
          {addTarget && (
            <>
              <h2 className='m-0 text-base font-semibold text-foreground'>
                Add {[addTarget.first_name, addTarget.last_name].filter(Boolean).join(' ') || 'member'} to a group
              </h2>
              {addError && <p className='mt-2 text-sm text-destructive'>{addError}</p>}
              {groups.length === 0 ? (
                <p className='mt-3 text-sm text-muted-foreground'>No special groups exist yet.</p>
              ) : (
                <div className='mt-3 flex flex-col gap-2'>
                  {groups.map((g) => {
                    const done = addedGroupId === g.id
                    return (
                      <button
                        key={g.id}
                        type='button'
                        disabled={adding}
                        onClick={() => handleAddToGroup(g.id)}
                        className='flex items-center justify-between rounded-xl border border-border bg-secondary px-4 py-3 text-left text-sm font-medium text-foreground hover:bg-accent disabled:opacity-60 cursor-pointer'
                      >
                        <span>{g.name}</span>
                        {done ? (
                          <span className='text-xs font-semibold text-success'>Added ✓</span>
                        ) : (
                          <span className='chip px-2 py-0.5 text-xs'>{g.member_count ?? 0}</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
              <Button
                type='button'
                variant='outline'
                className='mt-4 w-full'
                onClick={() => { setAddTarget(null); setAddError(null); setAddedGroupId(null) }}
              >
                Done
              </Button>
            </>
          )}
        </Modal>
      )}
    </PageShell>
  )
}

function MemberRow({
  member: m, isSuperAdmin, onAddToGroup,
}: {
  member: any
  isSuperAdmin: boolean
  onAddToGroup: () => void
}) {
  const name = [m.title, m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || m.id
  const unit = m.bacenta_name || m.governorship_name || m.council_name || m.stream_name || m.campus_name || ''
  const initials = [(m.first_name || '')[0], (m.last_name || '')[0]].filter(Boolean).join('').toUpperCase() || '?'

  return (
    <div className='flex items-center gap-2 rounded-2xl border border-border bg-card overflow-hidden'>
      <Link
        to={`/admin/members/${m.id}`}
        className='flex flex-1 items-center gap-3 p-3 no-underline min-w-0'
      >
        {m.picture_url ? (
          <img src={m.picture_url} alt={name} className='h-11 w-11 shrink-0 rounded-full object-cover' />
        ) : (
          <div className='flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-bold text-muted-foreground'>
            {initials}
          </div>
        )}
        <div className='min-w-0 flex-1'>
          <p className='m-0 truncate text-sm font-semibold text-foreground'>{name}</p>
          {(unit || m.email) && (
            <p className='m-0 mt-0.5 truncate text-xs text-muted-foreground'>{unit || m.email}</p>
          )}
        </div>
        <svg viewBox='0 0 24 24' width='16' height='16' fill='currentColor' className='shrink-0 text-muted-foreground'>
          <path d='M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z' />
        </svg>
      </Link>

      {isSuperAdmin && (
        <button
          type='button'
          onClick={onAddToGroup}
          className='shrink-0 mr-3 flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl border border-primary/30 text-primary hover:bg-primary/10'
          title='Add to special group'
          aria-label='Add to special group'
        >
          <svg viewBox='0 0 24 24' width='16' height='16' fill='currentColor'>
            <path d='M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z' />
          </svg>
        </button>
      )}
    </div>
  )
}
