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
  // pictureUrl is persisted to localStorage by the post-login graph sync —
  // see auth.ts:loginWithCredentials. May be empty on first login until the
  // fire-and-forget sync completes; we fall back to an initials avatar.
  const pictureUrl = typeof window !== 'undefined' ? localStorage.getItem('pictureUrl') : null
  const initials = [user?.firstName?.[0], user?.lastName?.[0]].filter(Boolean).join('').toUpperCase() || '?'
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
      <Avatar pictureUrl={pictureUrl} initials={initials} />
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

function Avatar({ pictureUrl, initials }: { pictureUrl: string | null; initials: string }) {
  const size = 36
  const common: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    border: '1.5px solid var(--border)',
    flexShrink: 0,
    background: 'var(--bg2)',
  }
  if (pictureUrl) {
    return (
      <img
        src={pictureUrl}
        alt={initials}
        width={size}
        height={size}
        style={{ ...common, objectFit: 'cover' }}
        // If the picture URL goes 404 mid-session (CDN churn, expired token),
        // hide the broken image so the layout doesn't show a torn-image icon.
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
      />
    )
  }
  return (
    <div
      aria-label={initials}
      style={{
        ...common,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--muted)',
        fontSize: 13,
        fontWeight: 700,
        letterSpacing: '0.03em',
      }}
    >
      {initials}
    </div>
  )
}
