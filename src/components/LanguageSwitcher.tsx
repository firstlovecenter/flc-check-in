import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from './ui/button'
import { useLanguage } from '../hooks/useLanguage'
import { cn } from '../lib/utils'

type LanguageSwitcherProps = {
  /** Compact icon trigger (default) or labelled row for dense menus. */
  variant?: 'icon' | 'row'
  className?: string
  /** Popover horizontal align relative to the trigger. */
  align?: 'start' | 'end'
  /** Which side of the trigger the menu opens toward. */
  side?: 'top' | 'bottom'
}

function LanguagesIcon({ className }: { className?: string }) {
  return (
    <svg viewBox='0 0 24 24' width='16' height='16' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden className={className}>
      <path d='m5 8 6 6' />
      <path d='m4 14 6-6 2-3' />
      <path d='M2 5h12' />
      <path d='M7 2h1' />
      <path d='m22 22-5-10-5 10' />
      <path d='M14 18h6' />
    </svg>
  )
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox='0 0 24 24' width='16' height='16' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden className={className}>
      <path d='M20 6 9 17l-5-5' />
    </svg>
  )
}

/**
 * Tap-friendly language picker — same pattern as the FL Admin Portal shell
 * (icon button + popover). Shares `flc-language` storage so both apps stay
 * in sync on one device.
 */
export default function LanguageSwitcher({
  variant = 'icon',
  className,
  align = 'end',
  side = 'bottom',
}: LanguageSwitcherProps) {
  const { t } = useTranslation()
  const { language, languages, setLanguage } = useLanguage()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const current = languages.find((item) => item.code === language) ?? languages[0]

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null
      if (rootRef.current && target && !rootRef.current.contains(target)) {
        setOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const pick = (code: string) => {
    setLanguage(code)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      {variant === 'row' ? (
        <button
          type='button'
          aria-label={t('language.ariaLabel')}
          aria-haspopup='listbox'
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((v) => !v)}
          className='flex h-11 w-full items-center gap-2.5 rounded-xl px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground'
        >
          <LanguagesIcon />
          <span className='flex-1 truncate text-left'>{t('language.menuLabel')}</span>
          <span className='truncate text-xs text-muted-foreground'>{current?.nativeName}</span>
        </button>
      ) : (
        <Button
          type='button'
          variant='ghost'
          size='icon'
          aria-label={t('language.ariaLabel')}
          title={t('language.menuLabel')}
          aria-haspopup='listbox'
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((v) => !v)}
          className='size-11 rounded-full border border-border bg-card text-muted-foreground shadow-sm hover:bg-secondary hover:text-foreground'
        >
          <LanguagesIcon />
        </Button>
      )}

      {open && (
        <div
          id={listId}
          role='listbox'
          aria-label={t('language.ariaLabel')}
          className={cn(
            'absolute z-[1090] w-56 rounded-2xl border border-border bg-card p-2 shadow-lg',
            side === 'bottom' ? 'top-full mt-2' : 'bottom-full mb-2',
            align === 'end' ? 'right-0' : 'left-0',
          )}
        >
          <p className='px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground'>
            {t('language.menuLabel')}
          </p>
          <ul className='m-0 list-none space-y-0.5 p-0'>
            {languages.map((lang) => {
              const selected = lang.code === language
              return (
                <li key={lang.code}>
                  <button
                    type='button'
                    role='option'
                    aria-selected={selected}
                    onClick={() => pick(lang.code)}
                    className={cn(
                      'flex min-h-11 w-full items-center gap-2 rounded-xl px-2.5 text-sm transition-colors',
                      selected
                        ? 'bg-secondary font-medium text-foreground'
                        : 'text-foreground hover:bg-secondary/70',
                    )}
                  >
                    <span className='flex-1 text-left'>{lang.nativeName}</span>
                    {selected && <CheckIcon className='shrink-0 text-primary' />}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
