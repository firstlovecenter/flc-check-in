import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getEventScopeRollup, type ScopeRollupRow } from '../../utils/supabaseCheckins'

const TOP_N = 5

/**
 * The top sub-scopes by attendance, inline on the dashboard.
 *
 * For anyone overseeing several sub-scopes the per-scope split IS the
 * dashboard — but it was buried behind a "breakdown" link. Surfaced here for
 * the leaders furthest behind and furthest ahead, with the full list one tap
 * away.
 *
 * Grouped server-side (migration 044). The previous breakdown computed this
 * from the full eligible roster on the client, which is the roster download
 * migration 037 removed — recreating it here would have undone that.
 */
export default function InlineScopeRollup({
  eventId,
  childLevel,
  allowedRoles,
  fullListTo,
}: {
  eventId: string
  childLevel: string
  allowedRoles?: string[] | null
  fullListTo: string
}) {
  const [rows, setRows] = useState<ScopeRollupRow[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setRows(null)
    setFailed(false)
    getEventScopeRollup({ eventId, childLevel, allowedRoles })
      .then((r) => { if (!cancelled) setRows(r) })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [eventId, childLevel, (allowedRoles || []).join('|')])

  // A breakdown is supplementary — never block or clutter the dashboard when it
  // can't be produced.
  if (failed || (rows && rows.length === 0)) return null

  return (
    <div>
      <div className='mb-2 flex items-center justify-between'>
        <p className='section-heading m-0 text-xs uppercase tracking-widest'>By {childLevel}</p>
        <Link to={fullListTo} className='text-[11px] font-semibold text-primary no-underline hover:underline'>
          See all
        </Link>
      </div>

      {!rows ? (
        <div className='space-y-2' aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className='h-9 animate-pulse rounded-xl bg-secondary' />
          ))}
        </div>
      ) : (
        <div className='overflow-hidden rounded-2xl border border-border bg-card'>
          {rows.slice(0, TOP_N).map((row, idx) => {
            const pct = row.expected > 0 ? Math.round((row.attended / row.expected) * 100) : 0
            return (
              <div key={row.church_id}>
                {idx > 0 && <div className='h-px bg-border' />}
                <div className='flex items-center gap-3 px-4 py-2.5'>
                  <div className='min-w-0 flex-1'>
                    <p className='m-0 truncate text-sm font-semibold text-foreground'>
                      {row.church_name || 'Unnamed'}
                    </p>
                    <div className='mt-1 h-1.5 overflow-hidden rounded-full bg-secondary'>
                      <div
                        className='h-full rounded-full bg-success'
                        style={{ width: `${Math.min(100, pct)}%` }}
                      />
                    </div>
                  </div>
                  <p className='m-0 shrink-0 text-xs font-semibold tabular-nums text-muted-foreground'>
                    {row.attended}/{row.expected}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
