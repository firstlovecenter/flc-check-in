// Small round refresh button — rendered in TopBar and ScreenHeader so users
// have a visible way to fetch fresh data on every screen, not just the ones
// where pull-to-refresh works (which is currently only LeaderHomeScreen).
//
// On click, publishes the global refresh signal (see useRefreshSignal).
// Spins for ~700ms after each click so the user gets immediate visual
// feedback even when the underlying fetch is fast.

import { useState } from 'react'
import { triggerRefresh } from '../hooks/useRefreshSignal'

interface Props {
  /** Optional override — usually you want the global trigger. */
  onClick?: () => void
}

export default function RefreshButton({ onClick }: Props) {
  const [spinning, setSpinning] = useState(false)
  function handleClick() {
    setSpinning(true)
    if (onClick) onClick()
    else triggerRefresh()
    // Spin animation is just visual feedback — kept short so rapid clicks
    // still feel responsive.
    window.setTimeout(() => setSpinning(false), 700)
  }
  return (
    <button
      type='button'
      onClick={handleClick}
      aria-label='Refresh'
      title='Refresh'
      className='p-1.5 cursor-pointer shrink-0'
      style={{
        background: 'transparent',
        border: 'none',
        color: 'var(--muted)',
        borderRadius: '50%',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: 0,
      }}
    >
      <svg
        viewBox='0 0 24 24'
        width={18}
        height={18}
        fill='currentColor'
        style={{
          animation: spinning ? 'spin 0.7s linear' : 'none',
          transformOrigin: 'center',
        }}
      >
        <path d='M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.74 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z' />
      </svg>
    </button>
  )
}
