import { Link } from 'react-router-dom'
import { formatDistanceToNowStrict } from 'date-fns'

export default function EventCardForLeader({ event }) {
  const endsIn = formatDistanceToNowStrict(new Date(event.ends_at), { addSuffix: false })
  const levelColor = `var(--badge-${event.scope_level}, var(--accent))`
  return (
    <Link
      to={`/events/${event.id}`}
      className='block p-5 transition-transform active:scale-[0.98]'
      style={{
        background: 'var(--card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-card)',
        boxShadow: 'var(--shadow-2)',
        textDecoration: 'none',
      }}
    >
      {/* Scope eyebrow */}
      <p
        className='eyebrow m-0 mb-2'
        style={{ color: 'var(--muted)' }}
      >
        <span style={{ color: levelColor }}>{event.scope_level}</span>
        {' · '}
        {event.scope_church_name}
      </p>

      <div className='flex items-start justify-between gap-3'>
        <div className='min-w-0 flex-1'>
          <h3
            className='text-base font-semibold m-0 truncate'
            style={{ color: 'var(--text)', letterSpacing: '-0.02em' }}
          >
            {event.name}
          </h3>
          {event.venue_name && (
            <p className='text-xs m-0 mt-0.5 flex items-center gap-1 truncate' style={{ color: 'var(--muted)' }}>
              <svg viewBox='0 0 24 24' width='11' height='11' fill='currentColor' style={{ flexShrink: 0 }}>
                <path d='M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z' />
              </svg>
              {event.venue_name}
            </p>
          )}
        </div>
        <div className='text-right shrink-0'>
          <p className='text-[10px] uppercase font-bold tracking-wider m-0' style={{ color: 'var(--muted)', letterSpacing: '0.06em' }}>Ends in</p>
          <p className='text-sm font-semibold m-0 mt-0.5' style={{ color: 'var(--text)' }}>{endsIn}</p>
        </div>
      </div>

      {/* Method badges */}
      <div className='mt-4 flex items-center gap-2'>
        {event.allowed_check_in_methods.map((m) => (
          <span
            key={m}
            className='text-[11px] font-semibold px-3 py-1'
            style={{
              background: 'var(--bg2)',
              border: '1.5px solid var(--border)',
              borderRadius: 'var(--radius-pill)',
              color: 'var(--muted)',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
            }}
          >
            {m}
          </span>
        ))}
      </div>
    </Link>
  )
}
