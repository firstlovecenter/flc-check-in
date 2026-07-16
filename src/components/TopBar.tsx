import type { ReactNode } from 'react'
import NavDrawer from './NavDrawer'
import RefreshButton from './RefreshButton'
import PullToRefreshIndicator from './PullToRefreshIndicator'
import type { AppUser } from '../types/app'

const LEVEL_BADGE: Record<string, string> = {
  bacenta: 'bg-members',
  governorship: 'bg-churches',
  council: 'bg-defaulters',
  stream: 'bg-arrivals',
  campus: 'bg-banking',
  oversight: 'bg-primary',
  denomination: 'bg-campaigns',
}

interface Props {
  user?: AppUser | null
  right?: ReactNode
}

export default function TopBar({ user, right = null }: Props) {
  const greeting = user?.firstName
    ? `Hi ${[user.title, user.firstName].filter(Boolean).join(' ')}`
    : 'Welcome'
  const badgeClass = user?.level ? (LEVEL_BADGE[user.level] ?? 'bg-primary') : 'bg-primary'
  const pictureUrl = typeof window !== 'undefined' ? localStorage.getItem('pictureUrl') : null
  const initials = [user?.firstName?.[0], user?.lastName?.[0]].filter(Boolean).join('').toUpperCase() || '?'

  return (
    <>
      <PullToRefreshIndicator />
      <header className='sticky top-0 z-10 flex items-center gap-3 border-b-0 bg-card px-4 py-3 shadow-sm'>
        <NavDrawer user={user} />
        <Avatar pictureUrl={pictureUrl} initials={initials} />
        <div className='min-w-0 flex-1'>
          <h1 className='m-0 truncate text-base font-semibold leading-tight tracking-tight text-foreground'>
            {greeting}
          </h1>
          {user?.unitName && (
            <p className='m-0 mt-0.5 truncate text-xs text-muted-foreground'>
              {user.unitName}
            </p>
          )}
        </div>
        {user?.level && (
          <span
            className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-primary-foreground ${badgeClass}`}
          >
            {user.level}
          </span>
        )}
        <div className='flex shrink-0 items-center gap-1 text-xs'>
          <RefreshButton />
          {right}
        </div>
      </header>
    </>
  )
}

function Avatar({ pictureUrl, initials }: { pictureUrl: string | null; initials: string }) {
  const size = 36
  if (pictureUrl) {
    return (
      <img
        src={pictureUrl}
        alt={initials}
        width={size}
        height={size}
        decoding='async'
        className='size-9 shrink-0 rounded-full border border-border bg-secondary object-cover'
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
      />
    )
  }
  return (
    <div
      aria-label={initials}
      className='flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-[13px] font-semibold text-muted-foreground'
    >
      {initials}
    </div>
  )
}
