import { useMemo, useState, useEffect } from 'react'
import { cn } from '../lib/utils'

export function useClientPagination<T>(
  items: T[],
  pageSize: number,
  /** Change this to force page back to 0 (e.g. search/filter key). */
  resetKey?: unknown,
) {
  const [page, setPage] = useState(0)
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize) || 1)
  const safePage = Math.min(page, totalPages - 1)

  useEffect(() => {
    setPage(0)
  }, [pageSize, resetKey])

  useEffect(() => {
    if (page !== safePage) setPage(safePage)
  }, [page, safePage])

  const pageItems = useMemo(() => {
    const start = safePage * pageSize
    return items.slice(start, start + pageSize)
  }, [items, safePage, pageSize])

  return {
    page: safePage,
    setPage,
    totalPages,
    pageItems,
    total: items.length,
    pageSize,
  }
}

export function PaginationControls({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
  noun = 'items',
  className,
}: {
  page: number
  totalPages: number
  total: number
  pageSize: number
  onPageChange: (page: number) => void
  noun?: string
  className?: string
}) {
  if (total === 0) return null

  const from = page * pageSize + 1
  const to = Math.min(total, (page + 1) * pageSize)
  const showPager = total > pageSize

  return (
    <div className={cn('flex flex-col items-center gap-2 border-t border-border pt-3', className)}>
      <p className='m-0 text-xs font-medium text-muted-foreground'>
        Showing {from}–{to} of {total} {noun}
        {showPager ? ` · ${pageSize}/page` : ''}
      </p>
      {showPager && (
        <div className='flex w-full max-w-sm items-center justify-between gap-3'>
          <button
            type='button'
            disabled={page === 0}
            onClick={() => onPageChange(page - 1)}
            className='btn-pill btn-secondary px-4 py-2 text-sm disabled:opacity-40 cursor-pointer'
          >
            ← Prev
          </button>
          <span className='text-xs font-semibold text-foreground'>
            Page {page + 1} / {totalPages}
          </span>
          <button
            type='button'
            disabled={page >= totalPages - 1}
            onClick={() => onPageChange(page + 1)}
            className='btn-pill btn-secondary px-4 py-2 text-sm disabled:opacity-40 cursor-pointer'
          >
            Next →
          </button>
        </div>
      )}
    </div>
  )
}
