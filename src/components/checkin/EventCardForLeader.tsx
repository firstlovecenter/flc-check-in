import { Link } from 'react-router-dom'
import { formatDistanceToNowStrict } from 'date-fns'
import { Badge } from '../ui/badge'

export default function EventCardForLeader({ event }) {
  const endsIn = formatDistanceToNowStrict(new Date(event.ends_at), { addSuffix: false })
  const levelColor = `var(--badge-${event.scope_level}, var(--accent))`

  return (
    <Link to={`/events/${event.id}`} className='event-row block no-underline transition-transform active:scale-[0.98]'>
      <div className='min-w-0 p-4'>
        <p className='m-0 mb-2.5 flex items-center gap-1.5 text-xs text-muted-foreground'>
          <span className='size-1.5 shrink-0 rounded-full' style={{ background: levelColor }} />
          <span className='font-semibold tracking-wide' style={{ color: levelColor }}>
            {event.scope_level?.toUpperCase()}
          </span>
          {' · '}
          {event.scope_church_name}
        </p>

        <div className='flex items-start justify-between gap-3'>
          <div className='min-w-0 flex-1'>
            <h3 className='m-0 truncate text-base font-bold tracking-tight text-foreground'>
              {event.name}
            </h3>
            {event.venue_name && (
              <p className='m-0 mt-1 flex items-center gap-1 truncate text-xs text-muted-foreground'>
                <svg viewBox='0 0 24 24' width='11' height='11' fill='currentColor' className='shrink-0 opacity-70'>
                  <path d='M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z' />
                </svg>
                {event.venue_name}
              </p>
            )}
          </div>

          <div className='flex shrink-0 flex-col items-end gap-0.5'>
            <span className='text-[10px] font-bold uppercase tracking-widest text-muted-foreground'>
              Ends in
            </span>
            <span className='text-sm font-bold tracking-tight text-primary'>{endsIn}</span>
          </div>
        </div>

        <div className='mt-3.5 flex flex-wrap items-center gap-1.5'>
          {event.allowed_check_in_methods.map((m) => (
            <Badge key={m} variant='outline' className='text-[10px] uppercase tracking-wide'>
              {m}
            </Badge>
          ))}
        </div>
      </div>
    </Link>
  )
}
