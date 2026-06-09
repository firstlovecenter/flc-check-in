import { forwardRef, type SelectHTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

// Native <select> (keeps platform pickers + accessibility for free) with
// tokenized styling and a custom chevron so it matches the design system
// instead of the browser default.
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <div className='relative'>
        <select
          ref={ref}
          className={cn('input-field w-full appearance-none pr-9', className)}
          {...props}
        >
          {children}
        </select>
        <svg
          viewBox='0 0 24 24'
          width='16'
          height='16'
          fill='none'
          stroke='currentColor'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
          aria-hidden='true'
          className='pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground'
        >
          <path d='M6 9l6 6 6-6' />
        </svg>
      </div>
    )
  },
)
