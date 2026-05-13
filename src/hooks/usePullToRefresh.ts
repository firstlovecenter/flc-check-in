import { useEffect, useRef, useState } from 'react'

const TRIGGER_DISTANCE = 72  // px pulled before releasing counts as refresh
const MAX_PULL = 100          // px — clamps the visual drag

interface Options {
  onRefresh: () => void
  /** Ref to the scrollable container. Defaults to document.documentElement. */
  scrollRef?: React.RefObject<HTMLElement | null>
}

export function usePullToRefresh({ onRefresh, scrollRef }: Options) {
  const [pullDistance, setPullDistance] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const startY = useRef<number | null>(null)
  const pulling = useRef(false)
  // Track pull distance in a ref so event-handler closures always read the
  // current value without needing to re-register on every setState tick.
  const pullDistanceRef = useRef(0)
  const onRefreshRef = useRef(onRefresh)
  useEffect(() => { onRefreshRef.current = onRefresh }, [onRefresh])

  useEffect(() => {
    function getScrollTop() {
      return scrollRef?.current ? scrollRef.current.scrollTop : window.scrollY
    }

    function onTouchStart(e: TouchEvent) {
      if (getScrollTop() > 0) return
      startY.current = e.touches[0].clientY
      pulling.current = true
    }

    function onTouchMove(e: TouchEvent) {
      if (!pulling.current || startY.current === null) return
      if (getScrollTop() > 0) { pulling.current = false; return }
      const delta = e.touches[0].clientY - startY.current
      if (delta <= 0) {
        pullDistanceRef.current = 0
        setPullDistance(0)
        return
      }
      // Rubber-band damping
      const clamped = Math.min(MAX_PULL, delta * 0.5)
      pullDistanceRef.current = clamped
      setPullDistance(clamped)
      if (clamped > 0) e.preventDefault()
    }

    function onTouchEnd() {
      if (!pulling.current) return
      pulling.current = false
      if (pullDistanceRef.current >= TRIGGER_DISTANCE) {
        setRefreshing(true)
        onRefreshRef.current()
        setTimeout(() => setRefreshing(false), 1000)
      }
      pullDistanceRef.current = 0
      setPullDistance(0)
      startY.current = null
    }

    const target = scrollRef?.current ?? document
    target.addEventListener('touchstart', onTouchStart as EventListener, { passive: true })
    target.addEventListener('touchmove', onTouchMove as EventListener, { passive: false })
    target.addEventListener('touchend', onTouchEnd as EventListener, { passive: true })

    return () => {
      target.removeEventListener('touchstart', onTouchStart as EventListener)
      target.removeEventListener('touchmove', onTouchMove as EventListener)
      target.removeEventListener('touchend', onTouchEnd as EventListener)
    }
  // Only re-register listeners when the scroll target changes — NOT on every
  // pullDistance state update, which was causing stale closures.
  }, [scrollRef]) // eslint-disable-line react-hooks/exhaustive-deps

  return { pullDistance, refreshing }
}
