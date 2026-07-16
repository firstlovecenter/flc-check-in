import { type ReactNode, useEffect, useState } from 'react'
import { cn } from '../lib/utils'
import { useChurchFocus } from '../contexts/ChurchFocusContext'
import type { ChurchRef } from '../types/app'

function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1) }

interface Props {
  /** Rendered when the user has no resolvable role scopes. */
  fallback?: ReactNode
}

export default function ChurchScopeSwitcher({ fallback }: Props) {
  const { focusedScope, availableScopes, isMultiScope, setFocusedScope } = useChurchFocus()
  const [open, setOpen] = useState(false)

  // Close on Escape key.
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open])

  if (availableScopes.length === 0) return fallback ? <>{fallback}</> : null

  const label = focusedScope ? (focusedScope.name || cap(focusedScope.level ?? '')) : 'All scopes'
  const levelLabel = focusedScope?.level ? cap(focusedScope.level) : null
  const dotColor = focusedScope?.level
    ? `var(--badge-${focusedScope.level}, var(--primary))`
    : undefined

  return (
    <>
      <button
        type='button'
        onClick={() => isMultiScope && setOpen(true)}
        aria-label={isMultiScope ? 'Switch scope' : label}
        aria-haspopup={isMultiScope ? 'dialog' : undefined}
        className={cn(
          'flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-colors',
          isMultiScope
            ? 'cursor-pointer border-border bg-secondary text-foreground hover:bg-accent active:brightness-95'
            : 'cursor-default border-border bg-secondary text-foreground',
        )}
      >
        {focusedScope && dotColor && (
          <span
            className='size-2 shrink-0 rounded-full'
            style={{ background: dotColor }}
          />
        )}
        <span className='max-w-[160px] truncate'>{label}</span>
        {levelLabel && (
          <span className='rounded-full bg-border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'>
            {levelLabel}
          </span>
        )}
        {isMultiScope && (
          <ChevronDownIcon />
        )}
      </button>

      {/* Bottom sheet overlay */}
      {open && (
        <>
          <div
            className='fixed inset-0 z-[900] bg-black/40'
            aria-hidden
            onClick={() => setOpen(false)}
          />
          <div
            role='dialog'
            aria-modal='true'
            aria-label='Switch scope'
            className='fixed inset-x-0 bottom-0 z-[910] rounded-t-2xl border-t border-border bg-background'
          >
            {/* Drag handle */}
            <div className='mx-auto mb-3 mt-3 h-1 w-10 rounded-full bg-border' />
            <p className='px-5 pb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground'>
              View scope
            </p>
            <div className='flex flex-col gap-1 px-3 pb-8'>
              <ScopeOption
                label='All scopes'
                sublabel='Events from all your roles'
                active={focusedScope === null}
                onClick={() => { setFocusedScope(null); setOpen(false) }}
              />
              {availableScopes.map((s) => (
                <ScopeOption
                  key={`${s.level}:${s.id}`}
                  label={s.name || cap(s.level ?? '')}
                  sublabel={s.level ? cap(s.level) : undefined}
                  levelColor={s.level ? `var(--badge-${s.level}, var(--primary))` : undefined}
                  active={focusedScope?.id === s.id && focusedScope?.level === s.level}
                  onClick={() => { setFocusedScope(s); setOpen(false) }}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </>
  )
}

function ScopeOption({ label, sublabel, levelColor, active, onClick }: {
  label: string
  sublabel?: string
  levelColor?: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors',
        active ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-secondary',
      )}
    >
      {levelColor ? (
        <span className='size-2.5 shrink-0 rounded-full' style={{ background: levelColor }} />
      ) : (
        <span className='size-2.5 shrink-0 rounded-full border border-border' />
      )}
      <div className='min-w-0 flex-1'>
        <p className='m-0 truncate text-sm font-semibold'>{label}</p>
        {sublabel && (
          <p className='m-0 mt-0.5 text-xs text-muted-foreground'>{sublabel}</p>
        )}
      </div>
      {active && <CheckIcon />}
    </button>
  )
}

function ChevronDownIcon() {
  return (
    <svg viewBox='0 0 24 24' width='12' height='12' fill='currentColor' className='shrink-0 text-muted-foreground' aria-hidden>
      <path d='M7 10l5 5 5-5z' />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox='0 0 24 24' width='16' height='16' fill='currentColor' className='shrink-0 text-primary' aria-hidden>
      <path d='M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z' />
    </svg>
  )
}

// Exported for use by the home screen scope label banner.
export function useCurrentScopeLabel(): string {
  const { focusedScope } = useChurchFocus()
  if (!focusedScope) return 'All scopes'
  return focusedScope.name || (focusedScope.level ? cap(focusedScope.level) : 'Unknown scope')
}
