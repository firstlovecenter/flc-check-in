import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import type { CheckinEventRow } from '../../types/app'

/** Ticks once a second so the countdown is live rather than fetched. */
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [enabled])
  return now
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

type Phase = 'ended' | 'paused' | 'live' | 'opens-soon' | 'scheduled'

function phaseOf(event: CheckinEventRow, now: number): Phase {
  const starts = new Date(event.starts_at).getTime()
  const ends = new Date(event.ends_at).getTime()
  if (event.status === 'ENDED' || now > ends) return 'ended'
  if (event.status === 'PAUSED') return 'paused'
  if (now >= starts) return 'live'
  // Check-in opens an hour before start (submit_checkin enforces this).
  if (now >= starts - 60 * 60 * 1000) return 'opens-soon'
  return 'scheduled'
}

const PHASE_STYLE: Record<Phase, string> = {
  live:         'border-success/40 bg-success/10 text-success',
  'opens-soon': 'border-primary/40 bg-primary/10 text-primary',
  paused:       'border-warning/40 bg-warning/10 text-warning',
  ended:        'border-border bg-secondary text-muted-foreground',
  scheduled:    'border-border bg-secondary text-muted-foreground',
}

const PHASE_LABEL_KEY: Record<Phase, string> = {
  live:         'events.phase.live',
  'opens-soon': 'events.phase.opensSoon',
  paused:       'events.phase.paused',
  ended:        'events.phase.ended',
  scheduled:    'events.phase.scheduled',
}

/**
 * The event's live state, made the loudest thing on the screen.
 */
export default function EventLiveHeader({ event }: { event: CheckinEventRow }) {
  const { t } = useTranslation()
  const phase = phaseOf(event, Date.now())
  const now = useNow(phase === 'live' || phase === 'opens-soon')
  const livePhase = phaseOf(event, now)

  const starts = new Date(event.starts_at).getTime()
  const ends = new Date(event.ends_at).getTime()

  let timing: string | null = null
  if (livePhase === 'live') timing = t('events.timingRemaining', { time: formatDuration(ends - now) })
  else if (livePhase === 'opens-soon') timing = t('events.timingStartsIn', { time: formatDuration(starts - now) })
  else if (livePhase === 'scheduled') {
    timing = new Date(starts).toLocaleString([], {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit',
    })
  }

  return (
    <div className={cn('flex items-center gap-3 rounded-2xl border px-4 py-3', PHASE_STYLE[livePhase])}>
      <span className='relative flex size-2.5 shrink-0'>
        {livePhase === 'live' && (
          <span className='absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75' />
        )}
        <span
          className={cn(
            'relative inline-flex size-2.5 rounded-full',
            livePhase === 'live' ? 'bg-success'
              : livePhase === 'paused' ? 'bg-warning'
              : livePhase === 'opens-soon' ? 'bg-primary'
              : 'bg-muted-foreground',
          )}
        />
      </span>
      <div className='min-w-0 flex-1'>
        <p className='m-0 text-sm font-bold tracking-tight'>{t(PHASE_LABEL_KEY[livePhase])}</p>
        {timing && <p className='m-0 mt-0.5 truncate text-xs opacity-80'>{timing}</p>}
      </div>
      {livePhase === 'ended' && (
        <span className='shrink-0 text-xs font-semibold'>{t('events.checkInClosed')}</span>
      )}
    </div>
  )
}

export function AttendanceBar({ attended, expected }: { attended: number; expected: number }) {
  const { t } = useTranslation()
  const pct = expected > 0 ? Math.round((attended / expected) * 100) : 0
  const ariaLabel = t('events.attendanceAria', { attended, expected })
  return (
    <div>
      <div className='mb-1.5 flex items-baseline justify-between gap-2'>
        <p className='m-0 text-sm font-semibold text-foreground'>
          {attended}{' '}
          <span className='font-normal text-muted-foreground'>
            {t('events.attendanceOf', { expected })}
          </span>
        </p>
        <p className='m-0 text-sm font-bold tabular-nums text-foreground'>{pct}%</p>
      </div>
      <div
        className='h-2.5 overflow-hidden rounded-full bg-secondary'
        role='progressbar'
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={ariaLabel}
      >
        <div
          className='h-full rounded-full bg-success transition-[width] duration-500 ease-out'
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </div>
  )
}
