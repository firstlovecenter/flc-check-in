import type { ReactNode } from 'react'
import { Card, CardContent } from '../ui/card'
import { cn } from '../../lib/utils'

export type EmptyStateKind = 'default' | 'no-scope' | 'no-match' | 'all-done'

interface EmptyStateProps {
  title: string
  description?: string
  icon?: ReactNode
  action?: ReactNode
  className?: string
  /** Visual tone — dashed card for “nothing to do / nothing here” states. */
  kind?: EmptyStateKind
}

const KIND_STYLE: Record<EmptyStateKind, string> = {
  default: '',
  'no-scope': 'border-dashed border-2 bg-transparent shadow-none',
  'no-match': 'border-dashed border-2 bg-transparent shadow-none',
  'all-done': 'border-dashed border-2 border-success/30 bg-success/5 shadow-none',
}

/**
 * Typed empty states (portal pattern): distinct copy for “pick a scope”,
 * “no matches”, and “all done” so blank lists never feel like a broken app.
 */
export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
  kind = 'default',
}: EmptyStateProps) {
  return (
    <Card className={cn('text-center', KIND_STYLE[kind], className)}>
      <CardContent className='flex flex-col items-center px-6 py-14'>
        {icon && (
          <div className='mb-4 flex size-14 items-center justify-center rounded-full bg-secondary text-muted-foreground'>
            {icon}
          </div>
        )}
        <p className='m-0 text-base font-semibold text-foreground'>{title}</p>
        {description && (
          <p className='m-0 mt-1 max-w-[28ch] text-sm text-muted-foreground'>{description}</p>
        )}
        {action && <div className='mt-5'>{action}</div>}
      </CardContent>
    </Card>
  )
}
