import type { ReactNode } from 'react'
import NavDrawer from './NavDrawer'
import RefreshButton from './RefreshButton'
import PullToRefreshIndicator from './PullToRefreshIndicator'
import ChurchScopeSwitcher from './ChurchScopeSwitcher'
import { useChurchFocus } from '../contexts/ChurchFocusContext'
import type { AppUser } from '../types/app'

interface Props {
  user?: AppUser | null
  right?: ReactNode
}

export default function TopBar({ user, right = null }: Props) {
  const { focusedHat } = useChurchFocus()
  const greeting = user?.firstName
    ? `Hi ${[user.title, user.firstName].filter(Boolean).join(' ')}`
    : 'Welcome'
  const pictureUrl = typeof window !== 'undefined' ? localStorage.getItem('pictureUrl') : null
  const initials = [user?.firstName?.[0], user?.lastName?.[0]].filter(Boolean).join('').toUpperCase() || '?'

  // Subtitle follows the ACTIVE HAT, not user.unitName. unitName comes from the
  // JWT's single "level" field — one value for a person who may hold several
  // roles — so it silently disagreed with whichever role the user was actually
  // acting under.
  const subtitle = focusedHat ? focusedHat.roleLabel : user?.unitName

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
          {subtitle && (
            <p className='m-0 mt-0.5 truncate text-xs text-muted-foreground'>
              {subtitle}
            </p>
          )}
        </div>
        {/* The active hat is switchable from EVERY screen that uses TopBar.
            It used to live only on Home, so users lost track of which identity
            they were in as soon as they navigated anywhere. */}
        <ChurchScopeSwitcher compact />
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
