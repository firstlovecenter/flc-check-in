// Wires the pull-to-refresh gesture to the global refresh signal and renders
// the rubber-band spinner that grows as the user pulls down.
//
// Mounted once per page via ScreenHeader / inline nav rows so every screen
// gets the gesture for free. The visual has two parts:
//   1. Inline hint row — shown at rest on touch devices only, giving users
//      a discoverable affordance without cluttering desktop views.
//   2. Fixed overlay spinner — floats above content while the user is pulling.

import { usePullToRefresh } from '../hooks/usePullToRefresh'
import { triggerRefresh } from '../hooks/useRefreshSignal'

export default function PullToRefreshIndicator() {
  const { pullDistance, refreshing } = usePullToRefresh({ onRefresh: triggerRefresh })
  const isPulling = pullDistance > 0 || refreshing

  return (
    <>
      {/* Inline hint — only on touch devices, only when idle */}
      {!isPulling && (
        <div
          className='hidden [@media(pointer:coarse)]:flex items-center justify-center gap-1.5 pb-2 pt-0'
          aria-hidden
        >
          <svg
            viewBox='0 0 24 24'
            width='13'
            height='13'
            fill='none'
            stroke='currentColor'
            strokeWidth='2'
            strokeLinecap='round'
            strokeLinejoin='round'
            className='text-muted-foreground/40 animate-bounce'
            style={{ animationDuration: '1.8s' }}
          >
            <path d='M12 5v14M5 12l7 7 7-7' />
          </svg>
          <span className='text-[11px] font-medium tracking-wide text-muted-foreground/40 select-none'>
            Pull to refresh
          </span>
        </div>
      )}

      {/* Fixed overlay — appears while pulling or refreshing */}
      {isPulling && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            height: `${pullDistance}px`,
            overflow: 'hidden',
            zIndex: 50,
            pointerEvents: 'none',
            transition: pullDistance === 0 ? 'height 0.2s ease' : 'none',
          }}
        >
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              border: '2.5px solid var(--accent)',
              borderTopColor: 'transparent',
              opacity: refreshing ? 1 : pullDistance / 72,
              animation: refreshing ? 'spin 0.7s linear infinite' : 'none',
              transform: refreshing ? 'none' : `rotate(${pullDistance * 3}deg)`,
            }}
          />
        </div>
      )}
    </>
  )
}
