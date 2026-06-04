import type { ReactNode } from 'react'
import { PageShell } from './PageShell'
import { Card, CardContent } from '../ui/card'

export function CenterCard({ children }: { children: ReactNode }) {
  return (
    <PageShell className='items-center justify-center p-4'>
      <Card className='w-full max-w-sm'>
        <CardContent className='p-6 text-center'>{children}</CardContent>
      </Card>
    </PageShell>
  )
}
