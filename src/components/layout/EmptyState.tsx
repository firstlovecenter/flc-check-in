import type { ReactNode } from 'react'
import { Card, CardContent } from '../ui/card'
import { cn } from '../../lib/utils'

interface EmptyStateProps {
  title: string
  description?: string
  icon?: ReactNode
  action?: ReactNode
  className?: string
}

export function EmptyState({ title, description, icon, action, className }: EmptyStateProps) {
  return (
    <Card className={cn('text-center', className)}>
      <CardContent className='flex flex-col items-center px-6 py-14'>
        {icon && (
          <div className='mb-4 flex size-14 items-center justify-center rounded-full bg-secondary text-muted-foreground'>
            {icon}
          </div>
        )}
        <p className='m-0 text-base font-semibold text-foreground'>{title}</p>
        {description && (
          <p className='m-0 mt-1 max-w-[24ch] text-sm text-muted-foreground'>{description}</p>
        )}
        {action && <div className='mt-5'>{action}</div>}
      </CardContent>
    </Card>
  )
}
