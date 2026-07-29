import { type ReactNode, useEffect, useState } from 'react'
import { cn } from '../lib/utils'
import { useChurchFocus } from '../contexts/ChurchFocusContext'
import type { RoleScope } from '../utils/roleScopes'

function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1) }

interface Props {
  /** Rendered when the user holds no role at all. */
  fallback?: ReactNode
  /** Compact variant for the top bar on screens other than Home. */
  compact?: boolean
}

/**
 * The hat switcher: which (role, church) pair is the user acting as?
 *
 * Every option names the ROLE as well as the church ("Governorship Admin ·
 * Emmanuel"). The previous version listed churches only, which meant a user
 * who both led and administered the same governorship saw one indistinguishable
 * chip, and a user with roles in two hierarchies had no way to tell which entry
 * was which.
 *
 * "All roles" stays available but is explicitly view-only — with several hats
 * active at once there is no single answer to "may I check in here?", so the
 * app declines to guess. Picking a specific hat is what unlocks actions.
 */
export default function ChurchScopeSwitcher({ fallback, compact = false }: Props) {
  const { focusedHat, availableHats, isMultiRole, setFocusedHat } = useChurchFocus()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open])

  if (availableHats.length === 0) return fallback ? <>{fallback}</> : null

  const dotColor = focusedHat
    ? `var(--badge-${focusedHat.level}, var(--primary))`
    : undefined

  return (
    <>
      <button
        type='button'
        onClick={() => isMultiRole && setOpen(true)}
        aria-label={isMultiRole ? 'Switch role' : (focusedHat?.displayName ?? 'All roles')}
        aria-haspopup={isMultiRole ? 'dialog' : undefined}
        className={cn(
          'flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-colors',
          isMultiRole
            ? 'cursor-pointer border-border bg-secondary text-foreground hover:bg-accent active:brightness-95'
            : 'cursor-default border-border bg-secondary text-foreground',
        )}
      >
        {focusedHat && dotColor && (
          <span className='size-2 shrink-0 rounded-full' style={{ background: dotColor }} />
        )}
        <span className={cn('truncate', compact ? 'max-w-[110px]' : 'max-w-[160px]')}>
          {focusedHat ? focusedHat.name : 'All roles'}
        </span>
        {focusedHat && !compact && (
          <span className='rounded-full bg-border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'>
            {focusedHat.source === 'admin' ? 'Admin' : 'Leader'}
          </span>
        )}
        {!focusedHat && (
          <span className='rounded-full bg-border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'>
            View
          </span>
        )}
        {isMultiRole && <ChevronDownIcon />}
      </button>

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
            aria-label='Switch role'
            className='fixed inset-x-0 bottom-0 z-[910] max-h-[80vh] overflow-y-auto rounded-t-2xl border-t border-border bg-background'
          >
            <div className='mx-auto mb-3 mt-3 h-1 w-10 rounded-full bg-border' />
            <p className='px-5 pb-1 text-xs font-semibold uppercase tracking-widest text-muted-foreground'>
              Acting as
            </p>
            <p className='px-5 pb-3 text-xs text-muted-foreground'>
              You hold {availableHats.length} roles. What you can do depends on
              which one you pick.
            </p>
            <div className='flex flex-col gap-1 px-3 pb-8'>
              {availableHats.map((hat) => (
                <HatOption
                  key={hat.key}
                  hat={hat}
                  active={focusedHat?.key === hat.key}
                  onClick={() => { setFocusedHat(hat); setOpen(false) }}
                />
              ))}

              <div className='my-2 border-t border-border' />

              <button
                type='button'
                onClick={() => { setFocusedHat(null); setOpen(false) }}
                className={cn(
                  'flex cursor-pointer items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors',
                  focusedHat === null ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-secondary',
                )}
              >
                <span className='size-2.5 shrink-0 rounded-full border border-border' />
                <div className='min-w-0 flex-1'>
                  <p className='m-0 truncate text-sm font-semibold'>All roles</p>
                  <p className='m-0 mt-0.5 text-xs text-muted-foreground'>
                    Browse every event you can see — view only
                  </p>
                </div>
                {focusedHat === null && <CheckIcon />}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  )
}

function HatOption({ hat, active, onClick }: {
  hat: RoleScope
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
      <span
        className='size-2.5 shrink-0 rounded-full'
        style={{ background: `var(--badge-${hat.level}, var(--primary))` }}
      />
      <div className='min-w-0 flex-1'>
        <p className='m-0 truncate text-sm font-semibold'>{hat.name}</p>
        <p className='m-0 mt-0.5 text-xs text-muted-foreground'>{hat.roleLabel}</p>
      </div>
      {active && <CheckIcon />}
    </button>
  )
}

/**
 * One-time explainer. Defaulting to a single role shows multi-role users fewer
 * events than they saw before the change; without this it reads as data loss.
 * Only shown to people who actually hold more than one hat.
 */
export function RoleScopeOnboarding() {
  const { needsOnboarding, dismissOnboarding, focusedHat, availableHats } = useChurchFocus()
  if (!needsOnboarding) return null

  return (
    <>
      <div className='fixed inset-0 z-[920] bg-black/50' aria-hidden />
      <div
        role='dialog'
        aria-modal='true'
        aria-labelledby='role-onboarding-title'
        className='fixed inset-x-4 top-1/2 z-[930] -translate-y-1/2 rounded-2xl border border-border bg-background p-6 shadow-lg sm:mx-auto sm:max-w-sm'
      >
        <h2 id='role-onboarding-title' className='mb-2 text-lg font-bold tracking-tight text-foreground'>
          You hold {availableHats.length} roles
        </h2>
        <p className='mb-3 text-sm text-muted-foreground'>
          Hineni now shows one role at a time, so what you can do on an event is
          always clear. You&apos;re currently acting as:
        </p>
        <div className='mb-4 rounded-xl border border-border bg-secondary px-4 py-3'>
          <p className='m-0 text-sm font-semibold text-foreground'>
            {focusedHat?.name ?? 'All roles'}
          </p>
          <p className='m-0 mt-0.5 text-xs text-muted-foreground'>
            {focusedHat?.roleLabel ?? 'View only'}
          </p>
        </div>
        <p className='mb-5 text-sm text-muted-foreground'>
          Tap the role chip at the top of any screen to switch. Your other
          events are still there.
        </p>
        <button
          type='button'
          onClick={dismissOnboarding}
          className='btn-pill btn-primary w-full'
        >
          Got it
        </button>
      </div>
    </>
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

/** Label for the active hat — used by the home screen banner. */
export function useCurrentScopeLabel(): string {
  const { focusedHat } = useChurchFocus()
  if (!focusedHat) return 'All roles'
  return focusedHat.name || cap(focusedHat.level ?? '')
}
