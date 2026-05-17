// Wires the pull-to-refresh gesture to the global refresh signal and renders
// the rubber-band spinner that grows as the user pulls down.
//
// Mounted once per page via TopBar / ScreenHeader so every screen gets the
// gesture for free — no per-screen plumbing required. The visual is a
// position:fixed bar so it floats above the page content regardless of
// where the header itself sits in the DOM.

import { usePullToRefresh } from '../hooks/usePullToRefresh'
import { triggerRefresh } from '../hooks/useRefreshSignal'

export default function PullToRefreshIndicator() {
  const { pullDistance, refreshing } = usePullToRefresh({ onRefresh: triggerRefresh })

  // Don't render anything when not pulling — saves a paint and prevents the
  // empty <div> from intercepting taps near the top of the page.
  if (pullDistance === 0 && !refreshing) return null

  return (
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
  )
}
