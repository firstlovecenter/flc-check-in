import { Link, useLocation, useNavigate } from 'react-router-dom'
import { cn } from '../lib/utils'
import { logout } from '../utils/auth'
import type { AppUser } from '../types/app'

const ICONS = {
  home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
  events: 'M19 4h-1V2h-2v2H8V2H6v2H5a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3zm1 15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8h16v8zM4 9V7a1 1 0 0 1 1-1h1v2h2V6h8v2h2V6h1a1 1 0 0 1 1 1v2H4z',
  plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z',
  history: 'M13 3a9 9 0 0 0-9 9H1l4 4 4-4H6a7 7 0 1 1 2.06 4.94l-1.42 1.42A9 9 0 1 0 13 3zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8z',
  members: 'M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z',
  report: 'M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z',
  profile: 'M12 12a4.8 4.8 0 1 0 0-9.6 4.8 4.8 0 0 0 0 9.6zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z',
  signout: 'M17 7l-1.4 1.4 2.6 2.6H10v2h8.2l-2.6 2.6L17 17l5-5-5-5zM4 5h8V3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8v-2H4V5z',
}

type NavItem = {
  label: string
  to: string
  icon: string
  accent?: boolean
  matches?: (pathname: string) => boolean
}

function itemsFor(user?: AppUser | null): NavItem[] {
  const home: NavItem = { label: 'Home', to: '/home', icon: ICONS.home }
  const history: NavItem = { label: 'History', to: '/history', icon: ICONS.history }

  if (user?.isAdmin) {
    return [
      home,
      history,
      { label: 'Create', to: '/admin/events/new', icon: ICONS.plus, accent: true },
      { label: 'Members', to: '/admin/members', icon: ICONS.members },
      { label: 'Reports', to: '/admin/reports', icon: ICONS.report },
    ]
  }

  return [
    home,
    { label: 'Events', to: '/events', icon: ICONS.events, matches: (path) => path.startsWith('/events') || path.startsWith('/checkin') },
    history,
    { label: 'Profile', to: '/profile', icon: ICONS.profile },
  ]
}

function isItemActive(item: NavItem, pathname: string) {
  if (item.matches) return item.matches(pathname)
  return pathname === item.to || (item.to !== '/home' && pathname.startsWith(`${item.to}/`))
}

function NavIcon({ path, className }: { path: string; className?: string }) {
  return (
    <svg viewBox='0 0 24 24' width='20' height='20' fill='currentColor' aria-hidden className={className}>
      <path d={path} />
    </svg>
  )
}

export default function NavDrawer({ user }: { user?: AppUser | null }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const items = itemsFor(user)

  function signOut() {
    logout()
    navigate('/', { replace: true })
  }

  return (
    <>
      <aside
        aria-label='Primary navigation'
        className='fixed inset-y-0 left-0 z-40 hidden w-[84px] flex-col items-center border-r border-border bg-card py-5 lg:flex'
      >
        <Link to='/home' aria-label='Hineni home' className='mb-8 rounded-xl transition-transform active:scale-[0.97]'>
          <img src='/app-icon.svg' alt='' width={36} height={36} className='rounded-xl' />
        </Link>

        <nav className='flex flex-col items-center gap-1.5'>
          {items.map((item) => {
            const active = isItemActive(item, pathname)
            return (
              <Link
                key={item.to}
                to={item.to}
                aria-current={active ? 'page' : undefined}
                aria-label={item.label}
                className={cn(
                  'flex w-16 flex-col items-center gap-1 rounded-xl px-1 py-2.5 text-[10px] font-medium no-underline transition-colors active:scale-[0.97]',
                  item.accent
                    ? 'my-1 bg-primary text-primary-foreground shadow-[0_12px_28px_-14px_hsl(var(--primary))] hover:brightness-95'
                    : active
                      ? 'bg-primary/12 text-primary'
                      : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                )}
              >
                <NavIcon path={item.icon} />
                <span>{item.label}</span>
              </Link>
            )
          })}
        </nav>

        <button
          type='button'
          onClick={signOut}
          aria-label='Log out'
          className='mt-auto flex size-11 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive active:scale-[0.97]'
        >
          <NavIcon path={ICONS.signout} />
        </button>
      </aside>

      <nav
        aria-label='Primary navigation'
        className='fixed inset-x-4 z-[1030] lg:hidden'
        style={{ bottom: 'max(1rem, env(safe-area-inset-bottom))' }}
      >
        <div className='mx-auto flex h-16 max-w-md items-center rounded-full border border-border/80 bg-card/90 px-2 shadow-[0_20px_50px_-20px_rgba(15,23,42,0.55)] backdrop-blur-xl'>
          {items.map((item) => {
            const active = isItemActive(item, pathname)
            if (item.accent) {
              return (
                <div key={item.to} className='flex min-w-0 flex-1 justify-center'>
                  <Link
                    to={item.to}
                    aria-label={item.label}
                    aria-current={active ? 'page' : undefined}
                    className='flex size-14 -translate-y-4 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_16px_36px_-16px_hsl(var(--primary))] transition-transform hover:brightness-95 active:scale-95'
                  >
                    <NavIcon path={item.icon} className='size-6' />
                  </Link>
                </div>
              )
            }

            return (
              <Link
                key={item.to}
                to={item.to}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-full min-w-0 flex-1 touch-manipulation flex-col items-center justify-center gap-1 rounded-full text-[10px] font-medium no-underline transition-colors active:scale-[0.97]',
                  active ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <NavIcon path={item.icon} />
                <span className='leading-none'>{item.label}</span>
              </Link>
            )
          })}
        </div>
      </nav>
    </>
  )
}
