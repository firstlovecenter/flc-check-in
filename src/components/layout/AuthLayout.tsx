import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

interface AuthLayoutProps {
  /** Product name shown above the card. Defaults to Hineni. */
  productName?: string
  /** Tagline under the product name. */
  tagline?: string
  children: ReactNode
  className?: string
}

/**
 * Auth shell aligned with FL Admin Portal LoginPage AuthShell:
 * ambient brand glow, grain overlay, logo tile, glass card.
 */
export function AuthLayout({
  productName = 'Hineni',
  tagline = 'Right here, right now',
  children,
  className,
}: AuthLayoutProps) {
  return (
    <div
      className={cn(
        'relative flex min-h-[100dvh] flex-col overflow-hidden bg-background pb-[env(safe-area-inset-bottom)]',
        className,
      )}
    >
      {/* Ambient brand radial glow — top */}
      <div
        aria-hidden='true'
        className='pointer-events-none absolute inset-x-0 -top-40 h-[520px]'
        style={{
          background:
            'radial-gradient(ellipse 75% 55% at 50% 0%, hsl(var(--brand) / 0.16) 0%, transparent 72%)',
        }}
      />
      {/* Subtle ambient glow — bottom */}
      <div
        aria-hidden='true'
        className='pointer-events-none absolute inset-x-0 -bottom-24 h-64'
        style={{
          background:
            'radial-gradient(ellipse 60% 50% at 50% 100%, hsl(var(--brand) / 0.07) 0%, transparent 80%)',
        }}
      />
      {/* Grain noise overlay */}
      <div
        aria-hidden='true'
        className='pointer-events-none fixed inset-0 z-10'
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
          backgroundRepeat: 'repeat',
          backgroundSize: '180px 180px',
          opacity: 0.028,
          mixBlendMode: 'overlay',
        }}
      />

      <div className='relative flex flex-1 flex-col items-center justify-center px-5 py-12'>
        <div className='mb-9 flex flex-col items-center gap-5'>
          <div className='relative flex items-center justify-center'>
            <div
              aria-hidden='true'
              className='absolute rounded-[20px] blur-2xl'
              style={{
                inset: '-12px',
                background: 'hsl(var(--brand) / 0.22)',
              }}
            />
            <div className='relative flex h-[68px] w-[68px] items-center justify-center overflow-hidden rounded-[20px] border border-border bg-card shadow-[0_4px_20px_0_rgb(0_0_0/0.10)] dark:shadow-[0_4px_24px_0_rgb(0_0_0/0.30),inset_0_1px_0_rgb(255_255_255/0.06)]'>
              <img
                src='/apple-touch-icon.png'
                alt=''
                width={44}
                height={44}
                className='app-logo size-11 object-contain'
              />
            </div>
          </div>

          <div className='text-center'>
            <h1 className='text-[22px] font-semibold tracking-tight text-foreground'>
              {productName}
            </h1>
            {tagline && (
              <p className='mt-1 text-sm text-muted-foreground'>{tagline}</p>
            )}
          </div>
        </div>

        <div className='w-full max-w-[360px]'>
          <div
            className={cn(
              'rounded-2xl border border-border bg-card/90 p-6 backdrop-blur-xl',
              'shadow-[0_8px_32px_0_rgb(0_0_0/0.10)]',
              'dark:bg-card/85 dark:shadow-[0_8px_40px_0_rgb(0_0_0/0.35),inset_0_1px_0_rgb(255_255_255/0.04)]',
            )}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
