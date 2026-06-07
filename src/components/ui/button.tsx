import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:ring-[3px] focus-visible:ring-[hsl(var(--ring)/0.5)] disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98] active:brightness-90',
  {
    variants: {
      variant: {
        default: 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] shadow-sm hover:brightness-110 active:brightness-90',
        destructive: 'bg-destructive text-white hover:brightness-110 active:brightness-90',
        outline: 'bg-card text-foreground shadow-sm ring-1 ring-border/50 hover:bg-primary/12 hover:text-primary active:bg-primary/18 active:text-primary',
        secondary: 'bg-secondary text-foreground shadow-sm hover:bg-primary/10 active:bg-primary/16',
        ghost: 'text-foreground hover:bg-secondary active:bg-secondary/70',
        link: 'text-primary underline-offset-4 hover:underline active:opacity-70',
      },
      size: {
        default: 'min-h-11 px-4 py-2',
        sm: 'min-h-9 px-3 text-xs',
        lg: 'min-h-12 px-6 text-base',
        icon: 'size-11 p-0',
        'icon-sm': 'size-9 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
)
Button.displayName = 'Button'

export { buttonVariants }
