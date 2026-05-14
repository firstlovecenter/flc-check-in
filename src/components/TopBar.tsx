import type { ReactNode } from 'react'
import NavDrawer from './NavDrawer'
import type { AppUser } from '../types/app'

// Maps level strings to badge background tokens
const LEVEL_BADGE: Record<string, string> = {
  bacenta:      'var(--badge-bacenta)',
  governorship: 'var(--badge-governorship)',
  council:      'var(--badge-council)',
  stream:       'var(--badge-stream)',
  campus:       'var(--badge-campus)',
  oversight:    'var(--badge-oversight)',
  denomination: 'var(--badge-denomination)',
}

interface Props {
  user?: AppUser | null
  right?: ReactNode
}

export default function TopBar({ user, right = null }: Props) {
  const greeting = user?.firstName
    ? `Hi ${[user.title, user.firstName].filter(Boolean).join(' ')}`
    : 'Welcome'
  const badgeColor = user?.level ? (LEVEL_BADGE[user.level] ?? 'var(--accent)') : undefined
  return (
    <header
      className='sticky top-0 z-10 px-4 py-3 flex items-center gap-3'
      style={{
        background: 'var(--card)',
        borderBottom: '1px solid var(--border)',
        boxShadow: 'var(--shadow-1)',
      }}
    >
      <NavDrawer user={user} />
      <div className='min-w-0 flex-1'>
        <h1 className='text-base font-semibold m-0 leading-tight truncate' style={{ color: 'var(--text)', letterSpacing: '-0.02em' }}>
          {greeting}
        </h1>
        {user?.unitName && (
          <p className='text-xs m-0 mt-0.5 truncate' style={{ color: 'var(--muted)' }}>
            {user.unitName}
          </p>
        )}
      </div>
      {user?.level && (
        <span
          className='shrink-0 text-xs font-bold uppercase tracking-wider px-2.5 py-1'
          style={{
            background: badgeColor,
            color: 'var(--ink)',
            borderRadius: 'var(--radius-pill)',
            fontSize: '10px',
            letterSpacing: '0.06em',
          }}
        >
          {user.level}
        </span>
      )}
      {right && (
        <div className='flex items-center gap-2 text-xs shrink-0'>
          {right}
        </div>
      )}
    </header>
  )
}
