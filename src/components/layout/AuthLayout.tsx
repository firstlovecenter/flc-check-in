import type { ReactNode } from 'react'
import { Card, CardContent } from '../ui/card'

interface AuthLayoutProps {
  title: string
  subtitle?: string
  children: ReactNode
}

export function AuthLayout({ title, subtitle, children }: AuthLayoutProps) {
  return (
    <div className='page-shell flex min-h-dvh flex-col items-center justify-center px-4 py-12'>
      <Card className='w-full max-w-sm overflow-hidden shadow-md'>
        <div className='h-1 bg-[hsl(var(--primary))]' aria-hidden />
        <CardContent className='flex flex-col gap-8 p-8 pt-8'>
          <div className='flex flex-col items-center gap-4 text-center'>
            <img
              src='/apple-touch-icon.png'
              alt='First Love Church'
              width={72}
              height={72}
              className='app-logo shrink-0'
            />
            <div>
              <h1 className='m-0 text-2xl font-semibold tracking-tight text-foreground'>{title}</h1>
              {subtitle && (
                <p className='m-0 mt-1 text-sm text-muted-foreground'>{subtitle}</p>
              )}
            </div>
          </div>
          {children}
        </CardContent>
      </Card>
    </div>
  )
}
