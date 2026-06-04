// Shared header row for screens other than LeaderHomeScreen (which uses TopBar).
//
// Layout: [Hamburger] [title centered] [right slot].
// Optionally renders a small "← back" link below the title for drill-down screens.

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import NavDrawer from './NavDrawer'
import RefreshButton from './RefreshButton'
import PullToRefreshIndicator from './PullToRefreshIndicator'
import { getCurrentUser } from '../utils/auth'

interface Props {
  title?: ReactNode
  back?: { to: string; label: string }
  onBack?: () => void
  right?: ReactNode
}

export default function ScreenHeader({ title, back, onBack, right }: Props) {
  const user = getCurrentUser()
  return (
    <>
    <PullToRefreshIndicator />
    <header className='sticky top-0 z-10 grid grid-cols-[auto_1fr_auto] items-center gap-3 border-b-0 bg-card px-4 py-3 shadow-sm'>
      <NavDrawer user={user} />
      <div className='min-w-0 text-center'>
        {title && (
          <h1 className='m-0 truncate text-base font-semibold leading-tight tracking-tight text-foreground'>
            {title}
          </h1>
        )}
        {back && (
          <Link to={back.to} className='text-xs text-primary no-underline hover:underline'>
            ← {back.label}
          </Link>
        )}
        {!back && onBack && (
          <button
            type='button'
            onClick={onBack}
            className='cursor-pointer border-0 bg-transparent p-0 text-xs text-primary hover:underline'
          >
            ← Back
          </button>
        )}
      </div>
      <div className='justify-self-end flex items-center gap-1 text-xs'>
        <RefreshButton />
        {right}
      </div>
    </header>
    </>
  )
}
