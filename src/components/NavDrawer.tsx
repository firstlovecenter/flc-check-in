// Hamburger drawer — slide-in left nav.
//
// Permission-aware: the menu items shown depend on the viewer's role.
// Items are hidden entirely rather than greyed out, per design decision.

import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { logout } from '../utils/auth'
import type { AppUser } from '../types/app'

function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    if (typeof window !== 'undefined') {
      return (localStorage.getItem('flc-theme') as 'dark' | 'light') || 'dark'
    }
    return 'dark'
  })
  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    localStorage.setItem('flc-theme', next)
    if (next === 'light') {
      document.documentElement.setAttribute('data-theme', 'light')
    } else {
      document.documentElement.removeAttribute('data-theme')
    }
  }
  return { theme, toggle }
}

const ICONS = {
  home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
  qr: 'M3 11h8V3H3v8zm2-6h4v4H5V5zm8 6h8V3h-8v8zm2-6h4v4h-4V5zM3 21h8v-8H3v8zm2-6h4v4H5v-4zm8 0h2v2h-2v-2zm4 0h2v2h-2v-2zm-2 2h2v2h-2v-2zm2 2h2v2h-2v-2zm-4 0h2v2h-2v-2z',
  plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z',
  history: 'M13 3a9 9 0 0 0-9 9H1l4 4 4-4H6a7 7 0 1 1 7 7c-1.93 0-3.68-.78-4.94-2.06l-1.42 1.42A9 9 0 1 0 13 3zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8z',
  report: 'M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z',
  faceId: 'M9 2H4v5h2V4h3V2zm11 0h-5v2h3v3h2V2zM6 17H4v5h5v-2H6v-3zm14 0h-2v3h-3v2h5v-5zM9 8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zM7 16c1.5 1.2 3.1 1.8 5 1.8s3.5-.6 5-1.8v-1c-1.5 1.2-3.1 1.8-5 1.8s-3.5-.6-5-1.8v1z',
  groups: 'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
  sync: 'M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z',
  profile: 'M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z',
  signout: 'M17 7l-1.4 1.4L18.2 11H10v2h8.2l-2.6 2.6L17 17l5-5-5-5zM4 5h8V3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8v-2H4V5z',
}

interface NavItemProps {
  to: string
  icon: string
  label: string
  onClick?: () => void
}
function NavItem({ to, icon, label, onClick }: NavItemProps) {
  return (
    <Link
      to={to}
      onClick={onClick}
      className='flex items-center gap-3 px-4 py-3 transition-colors'
      style={{ textDecoration: 'none', color: 'var(--text)', borderRadius: 'var(--radius-btn)' }}
    >
      <svg viewBox='0 0 24 24' width='20' height='20' fill='currentColor' style={{ color: 'var(--muted)' }}>
        <path d={icon} />
      </svg>
      <span className='text-sm font-semibold'>{label}</span>
    </Link>
  )
}

export default function NavDrawer({ user }: { user?: AppUser | null }) {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const { theme, toggle: toggleTheme } = useTheme()

  // Lock body scroll while the drawer is open
  useEffect(() => {
    if (open) {
      const prev = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      return () => { document.body.style.overflow = prev }
    }
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
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
      {/* Trigger button — drop into TopBar */}
      <button
        type='button'
        aria-label='Open menu'
        onClick={() => setOpen(true)}
        className='p-2 cursor-pointer'
        style={{ background: 'transparent', border: '1.5px solid var(--border)', borderRadius: 'var(--radius-btn)', lineHeight: 0 }}
      >
        <svg viewBox='0 0 24 24' width='18' height='18' fill='currentColor' style={{ color: 'var(--text)' }}>
          <path d='M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z' />
        </svg>
      </button>

      {/* Backdrop + drawer */}
      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            className='fixed inset-0'
            style={{ background: 'rgba(0,0,0,0.55)', zIndex: 1040 }}
          />
          <aside
            className='fixed top-0 bottom-0 left-0 w-72 max-w-[85vw] flex flex-col'
            style={{ background: 'var(--card)', borderRight: '1px solid var(--border)', boxShadow: 'var(--shadow-2)', zIndex: 1050 }}
            role='dialog'
            aria-label='Navigation'
          >
            {/* Header */}
            <div className='px-4 py-4' style={{ borderBottom: '1px solid var(--border)' }}>
              <div className='flex items-center justify-between'>
                <p className='text-sm font-bold m-0' style={{ color: 'var(--text)' }}>{fullName}</p>
                <button
                  type='button'
                  aria-label='Close menu'
                  onClick={() => setOpen(false)}
                  className='p-1.5 rounded-md cursor-pointer'
                  style={{ background: 'transparent', color: 'var(--muted)' }}
                >
                  <svg viewBox='0 0 24 24' width='18' height='18' fill='currentColor'>
                    <path d='M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z' />
                  </svg>
                </button>
              </div>
              {user?.unitName && (
                <p className='text-xs mt-1 m-0' style={{ color: 'var(--muted)' }}>
                  {user.unitName}
                  {user.level && (
                    <>
                      <span style={{ color: 'var(--border)' }}> · </span>
                      <span className='uppercase tracking-wider' style={{ color: 'var(--accent)' }}>{user.level}</span>
                    </>
                  )}
                </p>
              )}
            </div>

            {/* Nav items */}
            <nav className='flex-1 overflow-y-auto p-2 flex flex-col gap-1'>
              <NavItem to='/home'    icon={ICONS.home}    label='Home'          onClick={() => setOpen(false)} />
              <NavItem to='/events'  icon={ICONS.qr}      label='Events'        onClick={() => setOpen(false)} />
              {isAdmin && (
                <>
                  <NavItem to='/admin/reports'    icon={ICONS.report}  label='Reports'      onClick={() => setOpen(false)} />
                  <NavItem to='/admin/members'    icon={ICONS.profile} label='Members'      onClick={() => setOpen(false)} />
                </>
              )}
              {isSuperAdmin && (
                <NavItem to='/admin/groups' icon={ICONS.groups} label='Special Groups' onClick={() => setOpen(false)} />
              )}
              <NavItem to='/admin/history' icon={ICONS.history} label='Event History' onClick={() => setOpen(false)} />
            </nav>

            {/* Footer — profile · theme · sign out on one row */}
            <div className='p-3 flex items-center gap-2' style={{ borderTop: '1px solid var(--border)' }}>
              {/* Profile */}
              <Link
                to='/profile'
                onClick={() => setOpen(false)}
                aria-label='My profile'
                className='flex-1 flex items-center justify-center py-2.5 cursor-pointer'
                style={{ background: 'var(--bg2)', border: '1.5px solid var(--border)', borderRadius: 'var(--radius-btn)', color: 'var(--text)', textDecoration: 'none' }}
              >
                {pictureUrl ? (
                  <img src={pictureUrl} alt={fullName} width={24} height={24} decoding='async' style={{ borderRadius: '50%', objectFit: 'cover' }} />
                ) : (
                  <div style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--accent)', color: 'var(--bg)', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {initials}
                  </div>
                )}
              </Link>

              {/* Theme toggle */}
              <button
                type='button'
                onClick={toggleTheme}
                aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                className='flex-1 flex items-center justify-center py-2.5 cursor-pointer'
                style={{ background: 'var(--bg2)', border: '1.5px solid var(--border)', borderRadius: 'var(--radius-btn)', color: 'var(--text)' }}
              >
                {theme === 'dark' ? (
                  <svg viewBox='0 0 24 24' width='18' height='18' fill='currentColor'>
                    <path d='M12 7a5 5 0 1 0 0 10A5 5 0 0 0 12 7zm0-5a1 1 0 0 1 1 1v1a1 1 0 0 1-2 0V3a1 1 0 0 1 1-1zm0 16a1 1 0 0 1 1 1v1a1 1 0 0 1-2 0v-1a1 1 0 0 1 1-1zm9-9a1 1 0 0 1 0 2h-1a1 1 0 0 1 0-2h1zM4 12a1 1 0 0 1-1 1H2a1 1 0 0 1 0-2h1a1 1 0 0 1 1 1zm14.95 5.54a1 1 0 0 1 0 1.41l-.71.71a1 1 0 0 1-1.41-1.41l.71-.71a1 1 0 0 1 1.41 0zM5.05 6.46a1 1 0 0 1 0 1.41l-.71.71A1 1 0 0 1 2.93 7.17l.71-.71a1 1 0 0 1 1.41 0zm13.9-1.41a1 1 0 0 1 0 1.41l-.71.71a1 1 0 0 1-1.41-1.41l.71-.71a1 1 0 0 1 1.41 0zM5.05 17.54a1 1 0 0 1 1.41 0l.71.71a1 1 0 0 1-1.41 1.41l-.71-.71a1 1 0 0 1 0-1.41z' />
                  </svg>
                ) : (
                  <svg viewBox='0 0 24 24' width='18' height='18' fill='currentColor'>
                    <path d='M12 3a9 9 0 0 0 0 18c4.97 0 9-4.03 9-9a9.01 9.01 0 0 0-9-9zm0 16a7 7 0 1 1 0-14 7 7 0 0 1 0 14z' />
                    <path d='M12 3a9 9 0 1 1-6.36 15.36A9 9 0 0 0 12 3z' />
                  </svg>
                )}
              </button>

              {/* Sign out */}
              <button
                type='button'
                onClick={handleSignOut}
                aria-label='Sign out'
                className='flex-1 flex items-center justify-center py-2.5 cursor-pointer'
                style={{ background: 'transparent', border: '1.5px solid var(--border)', borderRadius: 'var(--radius-btn)', color: 'var(--coral)' }}
              >
                <svg viewBox='0 0 24 24' width='18' height='18' fill='currentColor'><path d={ICONS.signout} /></svg>
              </button>
            </div>
          </aside>
        </>
      )}
    </>
  )
}
