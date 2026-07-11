import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import ScreenHeader from '../ScreenHeader'
import { format, formatDistanceToNowStrict } from 'date-fns'
import {
  listAllEvents,
  listEventsAttendedByMember,
} from '../../utils/supabaseCheckins'
import { getCurrentUser } from '../../utils/auth'
import { useRefreshSignal } from '../../hooks/useRefreshSignal'
import { PageShell, PageMain } from '../layout/PageShell'
import { CenterCard } from '../layout/CenterCard'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import { PaginationControls, useClientPagination } from '../PaginationControls'

const FILTERS = ['ALL', 'ACTIVE', 'PAUSED', 'ENDED'] as const
const EVENTS_PAGE_SIZE = 5

export default function EventHistoryList() {
  const user = getCurrentUser()
  const [events, setEvents] = useState<any[]>([])
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('ALL')
  const [search, setSearch] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  useRefreshSignal(() => setRefreshKey((k) => k + 1))

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [scopeEvts, attendedEvts] = await Promise.all([
          listAllEvents(user ?? undefined, { limit: 200 }),
          listEventsAttendedByMember(user!.userId),
        ])
        if (cancelled) return
        const byId = new Map<string, any>()
        for (const e of scopeEvts) byId.set(e.id, e)
        for (const e of attendedEvts) if (!byId.has(e.id)) byId.set(e.id, e)
        const STATUS_RANK: Record<string, number> = { ACTIVE: 0, PAUSED: 1, ENDED: 2 }
        const merged = [...byId.values()].sort((a, b) => {
          const rankDiff = (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3)
          if (rankDiff !== 0) return rankDiff
          return new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime()
        })
        if (!cancelled) setEvents(merged)
      } catch (err: any) {
        if (!cancelled) setError(err.message)
      }
    })()
    return () => { cancelled = true }
  }, [user?.userId, refreshKey])

  const filtered = useMemo(() => {
    const base = filter === 'ALL' ? events : events.filter((e) => e.status === filter)
    const q = search.trim().toLowerCase()
    if (!q) return base
    return base.filter((e) => {
      const haystack = [e.name, e.scope_church_name, e.venue_name, e.scope_level, e.status]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [events, filter, search])

  const { page, setPage, totalPages, pageItems, total } = useClientPagination(
    filtered,
    EVENTS_PAGE_SIZE,
    `${filter}|${search}`,
  )

  if (error) {
    return (
      <CenterCard>
        <p className='text-destructive'>{error}</p>
      </CenterCard>
    )
  }

  return (
    <PageShell>
      <ScreenHeader
        title='History'
        right={
          user?.isAdmin ? (
            <Link to='/admin/reports' className='text-xs text-primary no-underline hover:underline'>
              Reports
            </Link>
          ) : null
        }
      />
      <PageMain className='flex flex-col gap-3'>
        <div className='tab-bar self-start'>
          {FILTERS.map((f) => (
            <button
              key={f}
              type='button'
              onClick={() => setFilter(f)}
              className={cn('tab-item', filter === f && 'tab-item--active')}
            >
              {f}
            </button>
          ))}
        </div>

        <div className='surface-card flex items-center gap-2 rounded-lg px-3 py-2'>
          <svg viewBox='0 0 24 24' width='16' height='16' fill='currentColor' className='shrink-0 text-muted-foreground'>
            <path d='M15.5 14h-.79l-.28-.27a6 6 0 1 0-.71.71l.27.28v.79L20 21.5 21.5 20l-6-6zm-5.5 0a4 4 0 1 1 0-8 4 4 0 0 1 0 8z' />
          </svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder='Search events, venue, church...'
            className='w-full border-0 bg-transparent text-sm text-foreground outline-none'
            aria-label='Search events'
          />
          {search && (
            <Button type='button' variant='ghost' size='sm' onClick={() => setSearch('')}>
              Clear
            </Button>
          )}
        </div>

        {filtered.length === 0 && (
          <p className='mt-6 text-center text-sm text-muted-foreground'>No events.</p>
        )}

        <div className='flex flex-col gap-2'>
          {pageItems.map((evt) => {
            const stripeClass =
              evt.status === 'ACTIVE'
                ? 'bg-success'
                : evt.status === 'PAUSED'
                  ? 'bg-warning'
                  : 'bg-muted-foreground'
            const isLive = evt.status === 'ACTIVE' || evt.status === 'PAUSED'
            const badgeVariant =
              evt.status === 'ACTIVE' ? 'success' : evt.status === 'PAUSED' ? 'warning' : 'muted'

            return (
              <Link key={evt.id} to={`/events/${evt.id}`} className='event-row flex overflow-hidden no-underline transition-all hover:brightness-105 active:scale-[0.99]'>
                <div className={cn('w-1 shrink-0', stripeClass)} />
                <div className='flex min-w-0 flex-1 items-center justify-between gap-3 px-4 py-3.5'>
                  <div className='min-w-0 flex-1'>
                    <p className='m-0 truncate text-sm font-bold tracking-tight text-foreground'>{evt.name}</p>
                    <p className='m-0 mt-0.5 truncate text-xs text-muted-foreground'>
                      {evt.scope_church_name}
                      {' · '}
                      <span className='text-[10px] font-bold uppercase tracking-wide text-primary'>
                        {evt.scope_level}
                      </span>
                      {evt.venue_name ? ` · ${evt.venue_name}` : ''}
                    </p>
                  </div>
                  <div className='min-w-[72px] shrink-0 text-right'>
                    <Badge variant={badgeVariant as 'success' | 'warning' | 'muted'}>{evt.status}</Badge>
                    <p className='m-0 mt-1.5 text-[11px] text-muted-foreground'>
                      {isLive
                        ? formatDistanceToNowStrict(new Date(evt.ends_at), { addSuffix: false })
                        : format(new Date(evt.starts_at), 'd MMM yy')}
                    </p>
                    {isLive && <p className='m-0 text-[10px] opacity-60 text-muted-foreground'>remaining</p>}
                  </div>
                </div>
              </Link>
            )
          })}
        </div>

        <PaginationControls
          page={page}
          totalPages={totalPages}
          total={total}
          pageSize={EVENTS_PAGE_SIZE}
          onPageChange={setPage}
          noun='events'
        />
      </PageMain>
    </PageShell>
  )
}
