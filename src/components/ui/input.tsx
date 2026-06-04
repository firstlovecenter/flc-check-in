import { forwardRef, type InputHTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = 'text', ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'flex min-h-11 w-full rounded-lg border border-border bg-card px-4 py-2 text-[0.9375rem] text-foreground outline-none transition-colors',
        'placeholder:text-muted-foreground focus:border-[hsl(var(--primary))] focus:ring-[3px] focus:ring-[hsl(var(--primary)/0.2)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = 'Input'
