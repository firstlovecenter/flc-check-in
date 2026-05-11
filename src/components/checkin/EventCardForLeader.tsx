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
        <h3
          className='text-base font-semibold m-0 min-w-0 truncate'
          style={{ color: 'var(--text)', letterSpacing: '-0.02em', flex: 1 }}
        >
          {event.name}
        </h3>
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
