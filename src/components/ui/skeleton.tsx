import { cn } from '../../lib/utils'

// Loading placeholder block. Token-based so it adapts to both themes; the
// pulse animation is disabled globally for prefers-reduced-motion users via
// the rule in index.css (animation-duration: 0.01ms).
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden='true'
      className={cn('animate-pulse rounded-xl bg-muted', className)}
      {...props}
    />
  )
}

/** A stack of row-shaped skeletons matching member-card dimensions. */
export function SkeletonRows({ count = 5, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)} aria-hidden='true'>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className='h-[68px] rounded-2xl' />
      ))}
    </div>
  )
}
