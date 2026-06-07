import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useTheme } from '../hooks/useTheme'
import { cn } from '../lib/utils'
import { logout } from '../utils/auth'
import type { AppUser } from '../types/app'

const ICONS = {
  home:    'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
  qr:      'M3 11h8V3H3v8zm2-6h4v4H5V5zm8 6h8V3h-8v8zm2-6h4v4h-4V5zM3 21h8v-8H3v8zm2-6h4v4H5v-4zm8 0h2v2h-2v-2zm4 0h2v2h-2v-2zm-2 2h2v2h-2v-2zm2 2h2v2h-2v-2zm-4 0h2v2h-2v-2z',
  plus:    'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z',
  history: 'M13 3a9 9 0 0 0-9 9H1l4 4 4-4H6a7 7 0 1 1 7 7c-1.93 0-3.68-.78-4.94-2.06l-1.42 1.42A9 9 0 1 0 13 3zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8z',
  report:  'M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z',
  groups:  'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
  sync:    'M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z',
  profile: 'M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z',
  signout: 'M17 7l-1.4 1.4L18.2 11H10v2h8.2l-2.6 2.6L17 17l5-5-5-5zM4 5h8V3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8v-2H4V5z',
  moon:    'M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z',
  sun:     'M12 7a5 5 0 1 0 0 10A5 5 0 0 0 12 7zm0-5a1 1 0 0 1 1 1v1a1 1 0 0 1-2 0V3a1 1 0 0 1 1-1zm0 16a1 1 0 0 1 1 1v1a1 1 0 0 1-2 0v-1a1 1 0 0 1 1-1zm9-9a1 1 0 0 1 0 2h-1a1 1 0 0 1 0-2h1zM4 12a1 1 0 0 1-1 1H2a1 1 0 0 1 0-2h1a1 1 0 0 1 1 1z',
  chevron: 'M7 10l5 5 5-5z',
}

function NavItem({ to, icon, label, onClick }: { to: string; icon: string; label: string; onClick?: () => void }) {
  const { pathname } = useLocation()
  const active = pathname === to || (to !== '/home' && pathname.startsWith(to + '/'))
  return (
    <Link
      to={to}
      onClick={onClick}
      className={cn(
        'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium no-underline transition-colors',
        active
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      <svg viewBox='0 0 24 24' width='18' height='18' fill='currentColor' className='shrink-0'>
        <path d={icon} />
      </svg>
      <span>{label}</span>
    </Link>
  )
}

export default function NavDrawer({ user }: { user?: AppUser | null }) {
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const navigate = useNavigate()
  const { resolved, toggle: toggleTheme } = useTheme()

  function close() {
    setClosing(true)
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => { setOpen(false); setClosing(false) }, 300)
  }
  useEffect(() => () => clearTimeout(closeTimer.current), [])

  useEffect(() => {
    if (open) {
      const prev = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      return () => { document.body.style.overflow = prev }
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const isAdmin = !!user?.isAdmin
  const isSuperAdmin = !!user?.isSuperAdmin
  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || 'Signed in'
  const pictureUrl = typeof window !== 'undefined' ? localStorage.getItem('pictureUrl') : null
  const initials = (user?.firstName?.[0] || user?.email?.[0] || '?').toUpperCase()

  function handleSignOut() {
    setOpen(false)
    logout()
    navigate('/', { replace: true })
  }

  return (
    <>
      <button
        type='button'
        aria-label='Open menu'
        onClick={() => setOpen(true)}
        className='cursor-pointer rounded-xl border-0 bg-primary p-2 leading-none text-primary-foreground shadow-sm hover:bg-primary/85'
      >
        <svg viewBox='0 0 24 24' width='20' height='20' fill='currentColor'>
          <path d='M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z' />
        </svg>
      </button>

      {open && (
        <>
          <div
            onClick={close}
            data-state={closing ? 'closed' : 'open'}
            className='drawer-backdrop fixed inset-0 z-[1040]'
          />
          <aside
            data-state={closing ? 'closed' : 'open'}
            className='drawer-panel fixed top-0 bottom-0 left-0 z-[1050] flex w-72 max-w-[85vw] flex-col bg-background'
            role='dialog'
            aria-label='Navigation'
          >
            {/* App header */}
            <div className='flex items-center gap-3 px-4 py-5'>
              <img src='/app-icon.svg' alt='FLC Check-In' className='h-9 w-9 shrink-0 rounded-full' />
              <div className='min-w-0'>
                <p className='m-0 text-sm font-semibold text-foreground leading-tight'>Hineni</p>
                <p className='m-0 text-xs text-muted-foreground leading-tight'>Check-In Portal</p>
              </div>
            </div>

            {/* Nav items */}
            <nav className='flex-1 overflow-y-auto px-2 flex flex-col gap-0.5'>
              <NavItem to='/home'         icon={ICONS.home}    label='Home'           onClick={close} />
              <NavItem to='/events'       icon={ICONS.qr}      label='Events'         onClick={close} />
              {isAdmin && (
                <>
                  <NavItem to='/admin/reports'  icon={ICONS.report}  label='Reports'        onClick={close} />
                  <NavItem to='/admin/members'  icon={ICONS.profile} label='Members'         onClick={close} />
                </>
              )}
              {isSuperAdmin && (
                <NavItem to='/admin/groups' icon={ICONS.groups} label='Groups'         onClick={close} />
              )}
              <NavItem to='/admin/history' icon={ICONS.history} label='History'        onClick={close} />
            </nav>

            {/* User footer */}
            <div className='border-t border-border p-3'>
              {userMenuOpen && (
                <div className='mb-2 rounded-xl border border-border bg-card p-3 flex flex-col gap-1 shadow-sm'>
                  <button
                    type='button'
                    onClick={() => { toggleTheme(); setUserMenuOpen(false) }}
                    className='flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-foreground hover:bg-accent w-full text-left cursor-pointer border-0 bg-transparent'
                  >
                    <svg viewBox='0 0 24 24' width='16' height='16' fill='currentColor'>
                      <path d={resolved === 'dark' ? ICONS.sun : ICONS.moon} />
                    </svg>
                    {resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                  </button>
                  <button
                    type='button'
                    onClick={handleSignOut}
                    className='flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-destructive hover:bg-destructive/10 w-full text-left cursor-pointer border-0 bg-transparent'
                  >
                    <svg viewBox='0 0 24 24' width='16' height='16' fill='currentColor'>
                      <path d={ICONS.signout} />
                    </svg>
                    Log out
                  </button>
                </div>
              )}

              <button
                type='button'
                onClick={() => setUserMenuOpen((v) => !v)}
                className='flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-accent cursor-pointer border-0 bg-transparent transition-colors'
              >
                {pictureUrl ? (
                  <img src={pictureUrl} alt={fullName} className='h-8 w-8 shrink-0 rounded-full object-cover' />
                ) : (
                  <div className='flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground'>
                    {initials}
                  </div>
                )}
                <div className='min-w-0 flex-1'>
                  <p className='m-0 text-[10px] uppercase tracking-wider text-muted-foreground leading-tight'>Signed in as</p>
                  <p className='m-0 text-sm font-medium text-foreground truncate leading-tight'>{fullName}</p>
                </div>
                <svg
                  viewBox='0 0 24 24' width='18' height='18' fill='currentColor'
                  className={cn('shrink-0 text-muted-foreground transition-transform', userMenuOpen && 'rotate-180')}
                >
                  <path d={ICONS.chevron} />
                </svg>
              </button>
            </div>
          </aside>
        </>
      )}
    </>
  )
}
