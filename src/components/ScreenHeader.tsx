// Shared header row for screens other than LeaderHomeScreen (which uses TopBar).
//
// Layout: [Hamburger] [title centered] [right slot].
// Optionally renders a small "← back" link below the title for drill-down screens.

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import NavDrawer from './NavDrawer'
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
    <header
      className='sticky top-0 z-10 px-4 py-3 grid grid-cols-[auto_1fr_auto] items-center gap-3'
      style={{
        background: 'var(--card)',
        borderBottom: '1px solid var(--border)',
        boxShadow: 'var(--shadow-1)',
      }}
    >
      <NavDrawer user={user} />
      <div className='min-w-0 text-center'>
        {title && (
          <h1
            className='text-base font-semibold m-0 leading-tight truncate'
            style={{ color: 'var(--text)', letterSpacing: '-0.02em' }}
          >
            {title}
          </h1>
        )}
        {back && (
          <Link to={back.to} className='text-xs' style={{ color: 'var(--accent)', textDecoration: 'none' }}>
            ← {back.label}
          </Link>
        )}
        {!back && onBack && (
          <button onClick={onBack} className='text-xs cursor-pointer' style={{ background: 'none', border: 'none', color: 'var(--accent)', padding: 0 }}>
            ← Back
          </button>
        )}
      </div>
      <div className='justify-self-end flex items-center gap-2 text-xs'>
        {right}
      </div>
    </header>
  )
}
