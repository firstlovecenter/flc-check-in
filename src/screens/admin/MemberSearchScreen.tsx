import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import ScreenHeader from '../../components/ScreenHeader'
import { PageShell, PageMain } from '../../components/layout/PageShell'
import { EmptyState } from '../../components/layout/EmptyState'
import { Modal } from '../../components/ui/modal'
import { Button } from '../../components/ui/button'
import { SkeletonRows } from '../../components/ui/skeleton'
import RequireAdmin from '../../components/admin/RequireAdmin'
import { getCurrentUser } from '../../utils/auth'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { useInfiniteScroll } from '../../hooks/useInfiniteScroll'
import {
  searchMemberProfiles, listMemberProfilesPaginated,
  listSpecialGroups, addMembersToSpecialGroup,
  type SpecialGroup,
} from '../../utils/supabaseCheckins'

const PAGE_SIZE = 50

export default function MemberSearchScreen() {
  return (
    <RequireAdmin>
      <MemberSearch />
    </RequireAdmin>
  )
}

function MemberSearch() {
  const { t } = useTranslation()
  const user = getCurrentUser()
  const isSuperAdmin = !!user?.isSuperAdmin
  const canSyncMembers = !!user?.level && user.level !== 'bacenta'
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const [query, setQuery] = useState(() => searchParams.get('q') || '')
  const debouncedQuery = useDebouncedValue(query, 300)
  const [page, setPage] = useState(0)
  const [members, setMembers] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [groups, setGroups] = useState<SpecialGroup[]>([])
  const [addTarget, setAddTarget] = useState<any | null>(null)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [addedGroupId, setAddedGroupId] = useState<string | null>(null)

  const isSearchMode = debouncedQuery.trim().length >= 2
  const hasMore = !isSearchMode && members.length < total

  useEffect(() => {
    const next = query.trim()
    const current = searchParams.get('q') || ''
    if (next === current) return
    if (next) setSearchParams({ q: next }, { replace: true })
    else setSearchParams({}, { replace: true })
  }, [query, searchParams, setSearchParams])

  useEffect(() => {
    if (!isSearchMode) {
      setPage(0)
      setMembers([])
    }
  }, [isSearchMode])

  useEffect(() => {
    if (isSearchMode) return
    let cancelled = false
    if (page === 0) setLoading(true)
    else setLoadingMore(true)
    setError(null)
    listMemberProfilesPaginated(page, PAGE_SIZE)
      .then(({ data, count }) => {
        if (cancelled) return
        setMembers((prev) => (page === 0 ? data : [...prev, ...data]))
        setTotal(count)
      })
      .catch((err) => { if (!cancelled) setError(err.message) })
      .finally(() => {
        if (!cancelled) { setLoading(false); setLoadingMore(false) }
      })
    return () => { cancelled = true }
  }, [page, isSearchMode])

  useEffect(() => {
    if (!isSearchMode) { setSearchResults([]); return }
    let cancelled = false
    setLoading(true)
    setError(null)
    searchMemberProfiles(debouncedQuery.trim(), 100)
      .then((data) => { if (!cancelled) setSearchResults(data) })
      .catch((err: any) => { if (!cancelled) setError(err.message || t('members.searchFailed')) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [debouncedQuery, isSearchMode])

  const loadMore = useCallback(() => {
    if (loading || loadingMore || !hasMore) return
    setPage((p) => p + 1)
  }, [loading, loadingMore, hasMore])

  const sentinelRef = useInfiniteScroll({
    enabled: !isSearchMode,
    hasMore,
    loading: loading || loadingMore,
    onLoadMore: loadMore,
  })

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
      setAddError(err.message || t('members.addToGroupFailed'))
    } finally {
      setAdding(false)
    }
  }

  const displayList = isSearchMode ? searchResults : members

  return (
    <PageShell>
      <ScreenHeader title={t('members.search.title')} />
      <PageMain className='flex flex-col gap-4'>
        {canSyncMembers && (
          <button
            type='button'
            onClick={() => navigate('/admin/sync-members')}
            className='btn-pill btn-secondary self-end px-4 py-2 text-sm cursor-pointer'
          >
            {t('empty.syncMembers')}
          </button>
        )}
        <input
          type='search'
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('members.search.placeholder')}
          className='input-field'
        />

        {loading && page === 0 && <SkeletonRows count={6} />}
        {error && <p className='text-sm text-destructive'>{error}</p>}

        {!loading && isSearchMode && searchResults.length === 0 && (
          <EmptyState
            kind='no-match'
            title={t('empty.noMembersFound')}
            description={t('empty.nothingMatched', { query: debouncedQuery.trim() })}
            action={
              <Button type='button' variant='secondary' size='sm' onClick={() => setQuery('')}>
                {t('common.clearSearch')}
              </Button>
            }
          />
        )}

        {!loading && !isSearchMode && members.length === 0 && (
          <EmptyState
            kind='no-scope'
            title={t('empty.noMembersYet')}
            description={t('empty.syncMembersHint')}
            action={
              canSyncMembers ? (
                <Button type='button' onClick={() => navigate('/admin/sync-members')}>
                  {t('empty.syncMembers')}
                </Button>
              ) : undefined
            }
          />
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

        {!isSearchMode && <div ref={sentinelRef} className='h-4' aria-hidden />}
        {loadingMore && (
          <p className='text-center text-xs text-muted-foreground'>{t('members.search.loadingMore')}</p>
        )}
        {!isSearchMode && !loading && total > 0 && (
          <p className='text-center text-xs text-muted-foreground'>
            {t('common.pagination.showing', {
              from: 1,
              to: members.length,
              total,
              noun: t('common.pagination.noun.items'),
            })}
          </p>
        )}
      </PageMain>

      {isSuperAdmin && (
        <Modal
          open={!!addTarget}
          onClose={() => { setAddTarget(null); setAddError(null); setAddedGroupId(null) }}
          variant='sheet'
        >
          {addTarget && (
            <>
              <h2 className='m-0 text-base font-semibold text-foreground'>
                {t('members.search.addToGroup')}
              </h2>
              {addError && <p className='mt-2 text-sm text-destructive'>{addError}</p>}
              {groups.length === 0 ? (
                <p className='mt-3 text-sm text-muted-foreground'>{t('members.search.noGroups')}</p>
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
                          <span className='text-xs font-semibold text-success'>{t('members.search.added')}</span>
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
                {t('common.close')}
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
  const { t } = useTranslation()
  const name = [m.title, m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || m.id
  const unit = m.bacenta_name || m.governorship_name || m.council_name || m.stream_name || m.campus_name || ''
  const initials = [(m.first_name || '')[0], (m.last_name || '')[0]].filter(Boolean).join('').toUpperCase() || '?'

  return (
    <div className='flex items-center gap-2 rounded-2xl border border-border bg-card overflow-hidden'>
      <Link
        to={`/admin/members/${m.id}`}
        className='flex min-w-0 flex-1 items-center gap-3 p-3 no-underline'
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
          className='mr-3 flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-primary/30 text-primary hover:bg-primary/10'
          title={t('members.search.addToGroup')}
          aria-label={t('members.search.addToGroup')}
        >
          <svg viewBox='0 0 24 24' width='16' height='16' fill='currentColor'>
            <path d='M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z' />
          </svg>
        </button>
      )}
    </div>
  )
}
