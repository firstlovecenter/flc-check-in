import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

interface PageShellProps {
  children: ReactNode
  className?: string
}

/** Full-page authenticated layout (gray canvas). */
export function PageShell({ children, className }: PageShellProps) {
  return (
    <div className={cn('page-shell flex min-h-dvh flex-col', className)}>
      {children}
    </div>
  )
}

export function PageMain({ children, className }: PageShellProps) {
  return (
    <main className={cn('mx-auto w-full max-w-5xl flex-1 px-4 py-5 sm:px-6 sm:py-6', className)}>
      {children}
    </main>
  )
}

export function PageMainNarrow({ children, className }: PageShellProps) {
  return (
    <main className={cn('mx-auto w-full max-w-lg flex-1 px-4 py-5 sm:px-6', className)}>
      {children}
    </main>
  )
}
