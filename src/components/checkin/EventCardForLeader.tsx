import { Link } from 'react-router-dom'
import { formatDistanceToNowStrict } from 'date-fns'

export default function EventCardForLeader({ event }) {
  const endsIn = formatDistanceToNowStrict(new Date(event.ends_at), { addSuffix: false })
  const levelColor = `var(--badge-${event.scope_level}, var(--accent))`
  return (
    <Link
      to={`/events/${event.id}`}
      className='block transition-transform active:scale-[0.98]'
      style={{
        background: 'var(--card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-card)',
        boxShadow: 'var(--shadow-1)',
        textDecoration: 'none',
      }}
    >
      <div className='p-4 min-w-0'>
        {/* Scope eyebrow — level shown via a leading status dot, not a side stripe */}
        <p className='text-xs m-0 mb-2.5 flex items-center gap-1.5' style={{ color: 'var(--muted)' }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: levelColor, flexShrink: 0 }} />
          <span style={{ color: levelColor, fontWeight: 600, letterSpacing: '0.03em' }}>{event.scope_level?.toUpperCase()}</span>
          {' · '}
          {event.scope_church_name}
        </p>

        <div className='flex items-start justify-between gap-3'>
          <div className='min-w-0 flex-1'>
            <h3
              className='text-base font-bold m-0 truncate'
              style={{ color: 'var(--text)', letterSpacing: '-0.025em' }}
            >
              {event.name}
            </h3>
            {event.venue_name && (
              <p className='text-xs m-0 mt-1 flex items-center gap-1 truncate' style={{ color: 'var(--muted)' }}>
                <svg viewBox='0 0 24 24' width='11' height='11' fill='currentColor' style={{ flexShrink: 0, opacity: 0.7 }}>
                  <path d='M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z' />
                </svg>
                {event.venue_name}
              </p>
            )}
          </div>

          {/* Ends-in chip */}
          <div
            className='shrink-0 flex flex-col items-end'
            style={{ gap: 2 }}
          >
            <span
              className='text-[10px] font-bold uppercase tracking-widest'
              style={{ color: 'var(--muted)', letterSpacing: '0.07em' }}
            >
              Ends in
            </span>
            <span
              className='text-sm font-bold'
              style={{ color: levelColor, letterSpacing: '-0.01em' }}
            >
              {endsIn}
            </span>
          </div>
        </div>

        {/* Method badges */}
        <div className='mt-3.5 flex items-center gap-1.5 flex-wrap'>
          {event.allowed_check_in_methods.map((m) => (
            <span
              key={m}
              className='text-[10px] font-bold px-2.5 py-0.5'
              style={{
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-pill)',
                color: 'var(--muted)',
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
              }}
            >
              {m}
            </span>
          ))}
        </div>
      </div>
    </Link>
  )
}
