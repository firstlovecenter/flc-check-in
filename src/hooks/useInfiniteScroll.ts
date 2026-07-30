import { useEffect, useRef } from 'react'

/**
 * IntersectionObserver sentinel for "load more" lists.
 * Mirrors the portal hook, without Apollo — callers own the page state.
 */
export function useInfiniteScroll(opts: {
  enabled?: boolean
  hasMore: boolean
  loading?: boolean
  onLoadMore: () => void
  /** Root margin so we prefetch slightly before the user hits the bottom. */
  rootMargin?: string
}) {
  const {
    enabled = true,
    hasMore,
    loading = false,
    onLoadMore,
    rootMargin = '240px',
  } = opts
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!enabled || !hasMore || loading) return
    const node = sentinelRef.current
    if (!node) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onLoadMore()
      },
      { root: null, rootMargin, threshold: 0 },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [enabled, hasMore, loading, onLoadMore, rootMargin])

  return sentinelRef
}
