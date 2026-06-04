import { useRegisterSW } from 'virtual:pwa-register/react'
import { Button } from './ui/button'

export default function UpdatePrompt() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW()

  if (!needRefresh) return null

  return (
    <div className='surface-card fixed bottom-5 left-1/2 z-[9999] flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 items-center gap-4 px-5 py-4 shadow-lg'>
      <div className='min-w-0 flex-1'>
        <p className='m-0 text-sm font-semibold text-foreground'>Update available</p>
        <p className='m-0 mt-0.5 text-xs text-muted-foreground'>
          A new version of the app is ready.
        </p>
      </div>
      <Button size='sm' className='shrink-0' onClick={() => updateServiceWorker(true)}>
        Refresh
      </Button>
    </div>
  )
}
