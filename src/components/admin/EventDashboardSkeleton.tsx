import { Skeleton } from '../ui/skeleton'

/** Layout-matching skeleton for the event dashboard — mirrors title, stats, rollup. */
export default function EventDashboardSkeleton() {
  return (
    <div className='mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-5 sm:px-6' aria-busy='true' aria-label='Loading event details'>
      <div className='flex items-center justify-between'>
        <Skeleton className='h-4 w-16' />
        <div className='flex gap-2'>
          <Skeleton className='size-9 rounded-full' />
          <Skeleton className='size-9 rounded-full' />
        </div>
      </div>

      <Skeleton className='h-16 w-full rounded-2xl' />

      <div>
        <Skeleton className='h-7 w-2/3' />
        <Skeleton className='mt-2 h-4 w-1/3' />
      </div>

      <Skeleton className='h-11 w-full rounded-xl' />

      <Skeleton className='h-3 w-full rounded-full' />

      <div className='grid grid-cols-3 gap-2'>
        <Skeleton className='h-20 rounded-2xl' />
        <Skeleton className='h-20 rounded-2xl' />
        <Skeleton className='h-20 rounded-2xl' />
      </div>

      <div className='space-y-2'>
        <Skeleton className='h-4 w-24' />
        <Skeleton className='h-10 w-full rounded-xl' />
        <Skeleton className='h-10 w-full rounded-xl' />
        <Skeleton className='h-10 w-full rounded-xl' />
      </div>
    </div>
  )
}
