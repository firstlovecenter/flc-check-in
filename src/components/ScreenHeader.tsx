// Shared header row for all screens.
// Layout: [back or spacer] [title centered] [actions · language].

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import NavDrawer from './NavDrawer'
import LanguageSwitcher from './LanguageSwitcher'
import PullToRefreshIndicator from './PullToRefreshIndicator'
import { getCurrentUser } from '../utils/auth'

interface Props {
  title?: ReactNode
  back?: { to: string; label: string }
  onBack?: () => void
  right?: ReactNode
}

export default function ScreenHeader({ title, back, onBack, right }: Props) {
  const { t } = useTranslation()
  const user = getCurrentUser()
  const hasBack = !!(back || onBack)

  return (
    <>
      <PullToRefreshIndicator />
      <header className='sticky top-0 z-10 grid grid-cols-[auto_1fr_auto] items-center gap-3 border-b-0 bg-card px-4 py-3 shadow-sm'>

        {/* Left — back button or invisible spacer to keep title centred */}
        {hasBack ? (
          back ? (
            <Link
              to={back.to}
              viewTransition
              className='flex items-center gap-1 text-xs font-medium text-primary no-underline hover:underline'
            >
              <svg viewBox='0 0 24 24' width='14' height='14' fill='currentColor'>
                <path d='M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z' />
              </svg>
              {back.label}
            </Link>
          ) : (
            <button
              type='button'
              onClick={onBack}
              className='flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-xs font-medium text-primary hover:underline'
            >
              <svg viewBox='0 0 24 24' width='14' height='14' fill='currentColor'>
                <path d='M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z' />
              </svg>
              {t('common.back')}
            </button>
          )
        ) : (
          <span className='w-9' aria-hidden />
        )}

        {/* Centre — title */}
        <div className={`min-w-0 ${hasBack ? 'text-left' : 'text-center'}`}>
          {title && (
            <h1 className='m-0 truncate text-base font-semibold leading-tight tracking-tight text-foreground'>
              {title}
            </h1>
          )}
        </div>

        {/* Right — screen actions, then language (in-flow so nothing is covered). */}
        <div className='flex items-center gap-1.5'>
          {right}
          <LanguageSwitcher />
        </div>

      </header>
      <NavDrawer user={user} />
    </>
  )
}
