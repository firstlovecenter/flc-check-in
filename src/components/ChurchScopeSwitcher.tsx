import { type ReactNode } from 'react'
import { cn } from '../lib/utils'
import { Select } from './ui/select'
import { useChurchFocus } from '../contexts/ChurchFocusContext'
import type { RoleScope } from '../utils/roleScopes'

const ALL_ROLES_VALUE = '__ALL__'

function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1) }

/** "Philippians · Stream · Admin" — church, then level, then role.
 *  Mirrors the FL Admin Portal's ChurchRoleScopePicker option format so the two
 *  apps read identically to someone who uses both. */
function optionLabel(hat: RoleScope): string {
  return `${hat.name} · ${cap(hat.level)} · ${hat.source === 'admin' ? 'Admin' : 'Leader'}`
}

interface Props {
  /** Rendered when the user holds no role at all. */
  fallback?: ReactNode
  /** `full` — labelled, full-width, for the drawer and Home (portal parity).
   *  `compact` — bare select for the top bar, so switching stays one tap away
   *  on every screen without the label eating horizontal space. */
  variant?: 'full' | 'compact'
  className?: string
}

/**
 * Church in Focus — which (role, church) pair is the user acting as?
 *
 * Rebuilt to match the FL Admin Portal's picker: a labelled native select whose
 * current value is always visible, rather than a chip that opened a bottom
 * sheet. Two reasons that is better here:
 *
 *   • The active identity is readable at a glance without interaction. A chip
 *     showing only the church name could not say whether you were acting as its
 *     leader or its admin.
 *   • A native <select> gets the platform picker for free, which on a phone is a
 *     better control than a hand-rolled sheet — and this app is mobile-first.
 */
export default function ChurchScopeSwitcher({
  fallback,
  variant = 'full',
  className,
}: Props) {
  const { focusedHat, availableHats, setFocusedHat } = useChurchFocus()

  if (availableHats.length === 0) return fallback ? <>{fallback}</> : null

  const value = focusedHat?.key ?? ALL_ROLES_VALUE

  function handleChange(next: string) {
    if (next === ALL_ROLES_VALUE) { setFocusedHat(null); return }
    const hat = availableHats.find((h) => h.key === next)
    if (hat) setFocusedHat(hat)
  }

  const select = (
    <Select
      value={value}
      onChange={(e) => handleChange(e.target.value)}
      aria-label='Church in focus'
      className={cn(
        'border-primary/40 bg-primary/10 font-semibold',
        variant === 'compact' && 'h-9 max-w-[190px] py-1 text-xs',
      )}
    >
      {availableHats.map((hat) => (
        <option key={hat.key} value={hat.key}>{optionLabel(hat)}</option>
      ))}
      {/* Read-only browse mode. Deliberately last: it grants no capability, so
          it should never be what someone lands on by accident. */}
      <option value={ALL_ROLES_VALUE}>All roles · view only</option>
    </Select>
  )

  if (variant === 'compact') {
    return <div className={cn('shrink-0', className)}>{select}</div>
  }

  return (
    <div className={cn('w-full', className)}>
      <p className='mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground'>
        <span aria-hidden className='size-1.5 rounded-full bg-primary' />
        Church in Focus
      </p>
      {select}
    </div>
  )
}

/** Label for the active hat — used by the home screen banner. */
export function useCurrentScopeLabel(): string {
  const { focusedHat } = useChurchFocus()
  if (!focusedHat) return 'All roles'
  return focusedHat.name || cap(focusedHat.level ?? '')
}
