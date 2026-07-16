import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useTheme } from '../hooks/useTheme'
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
  more: 'M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  groups: 'M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
  theme: 'M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z',
  search: 'M9.5 3a6.5 6.5 0 1 0 4.23 11.43l5 4.99 1.41-1.41-4.99-5A6.5 6.5 0 0 0 9.5 3zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z',
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
    ]
  }

  return [
    home,
    { label: 'Events', to: '/events', icon: ICONS.events, matches: (path) => path.startsWith('/events') || path.startsWith('/checkin') },
    history,
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
  const [moreOpen, setMoreOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const { label: themeLabel, toggle: toggleTheme } = useTheme()
  const secondaryActive = pathname === '/profile' || pathname === '/admin/reports' || pathname.startsWith('/admin/groups')

  useEffect(() => {
    if (!moreOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    const focusTimer = window.setTimeout(() => searchRef.current?.focus(), 0)
    return () => {
      window.clearTimeout(focusTimer)
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [moreOpen])

  function signOut() {
    setMoreOpen(false)
    logout()
    navigate('/', { replace: true })
  }

  function searchMembers(value: string) {
    const query = value.trim()
    setMoreOpen(false)
    navigate(query ? `/admin/members?q=${encodeURIComponent(query)}` : '/admin/members')
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
          <MoreButton active={secondaryActive} expanded={moreOpen} onClick={() => setMoreOpen(true)} />
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
          <MoreButton active={secondaryActive} expanded={moreOpen} onClick={() => setMoreOpen(true)} mobile />
        </div>
      </nav>

      {moreOpen && (
        <>
          <button
            type='button'
            aria-label='Close more menu'
            onClick={() => setMoreOpen(false)}
            className='fixed inset-0 z-[1060] cursor-default bg-black/40 backdrop-blur-[2px]'
          />
          <section
            role='dialog'
            aria-modal='true'
            aria-labelledby='more-menu-title'
            className='fixed inset-x-3 bottom-3 z-[1070] mx-auto max-h-[calc(100dvh-1.5rem)] max-w-md overflow-y-auto rounded-[28px] border border-border bg-card p-3 shadow-2xl lg:inset-y-4 lg:right-auto lg:left-[96px] lg:m-0 lg:w-80 lg:max-w-none lg:rounded-3xl'
            style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
          >
            <div className='flex items-center gap-3 px-2 py-2'>
              <UserAvatar user={user} />
              <div className='min-w-0 flex-1'>
                <h2 id='more-menu-title' className='m-0 truncate text-sm font-semibold text-foreground'>
                  {[user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || 'Signed in'}
                </h2>
                <p className='m-0 truncate text-xs text-muted-foreground'>{user?.unitName || 'Hineni'}</p>
              </div>
              <button type='button' onClick={() => setMoreOpen(false)} aria-label='Close menu' className='flex size-10 items-center justify-center rounded-full text-xl text-muted-foreground hover:bg-secondary active:scale-[0.97]'>×</button>
            </div>

            {user?.isAdmin && (
              <form
                className='my-2 flex items-center gap-2 rounded-2xl bg-secondary px-3'
                onSubmit={(event) => {
                  event.preventDefault()
                  searchMembers(searchRef.current?.value || '')
                }}
              >
                <NavIcon path={ICONS.search} className='shrink-0 text-muted-foreground' />
                <input ref={searchRef} type='search' placeholder='Search members…' aria-label='Search members' className='h-12 min-w-0 flex-1 border-0 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground' />
              </form>
            )}

            <div className='grid gap-1'>
              {user?.isAdmin && <MenuLink to='/events' icon={ICONS.events} label='Live Events' onClick={() => setMoreOpen(false)} />}
              {user?.isAdmin && <MenuLink to='/admin/reports' icon={ICONS.report} label='Reports' onClick={() => setMoreOpen(false)} />}
              {user?.isSuperAdmin && <MenuLink to='/admin/groups' icon={ICONS.groups} label='Special Groups' onClick={() => setMoreOpen(false)} />}
              <MenuLink to='/profile' icon={ICONS.profile} label='My profile' onClick={() => setMoreOpen(false)} />
              <button type='button' onClick={toggleTheme} className='flex min-h-12 w-full items-center gap-3 rounded-2xl px-3 text-left text-sm font-medium text-foreground hover:bg-secondary active:scale-[0.97]'>
                <NavIcon path={ICONS.theme} className='text-muted-foreground' />
                Theme
                <span className='ml-auto text-xs text-muted-foreground'>{themeLabel}</span>
              </button>
              <button type='button' onClick={signOut} className='flex min-h-12 w-full items-center gap-3 rounded-2xl px-3 text-left text-sm font-medium text-destructive hover:bg-destructive/10 active:scale-[0.97]'>
                <NavIcon path={ICONS.signout} />
                Log out
              </button>
            </div>
          </section>
        </>
      )}
    </>
  )
}

function MoreButton({ active, expanded, onClick, mobile = false }: { active: boolean; expanded: boolean; onClick: () => void; mobile?: boolean }) {
  return (
    <button
      type='button'
      onClick={onClick}
      aria-label='More navigation options'
      aria-expanded={expanded}
      className={cn(
        mobile
          ? 'flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-full text-[10px] font-medium transition-colors active:scale-[0.97]'
          : 'flex w-16 flex-col items-center gap-1 rounded-xl px-1 py-2.5 text-[10px] font-medium transition-colors active:scale-[0.97]',
        active ? 'text-primary lg:bg-primary/12' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
      )}
    >
      <NavIcon path={ICONS.more} />
      <span className='leading-none'>More</span>
    </button>
  )
}

function MenuLink({ to, icon, label, onClick }: { to: string; icon: string; label: string; onClick: () => void }) {
  return (
    <Link to={to} onClick={onClick} className='flex min-h-12 items-center gap-3 rounded-2xl px-3 text-sm font-medium text-foreground no-underline hover:bg-secondary active:scale-[0.97]'>
      <NavIcon path={icon} className='text-muted-foreground' />
      {label}
    </Link>
  )
}

function UserAvatar({ user }: { user?: AppUser | null }) {
  const pictureUrl = typeof window !== 'undefined' ? localStorage.getItem('pictureUrl') : null
  const initials = (user?.firstName?.[0] || user?.email?.[0] || '?').toUpperCase()
  return pictureUrl ? (
    <img src={pictureUrl} alt='' width={40} height={40} className='size-10 rounded-full object-cover' />
  ) : (
    <span className='flex size-10 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground'>{initials}</span>
  )
}
