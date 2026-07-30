import { useState } from 'react'
import { Button } from '../ui/button'
import { Alert } from '../ui/alert'
import { snapshotEventScopeFromGraph } from '../../utils/eventScopeSnapshot'
import { addAuditLog } from '../../utils/supabaseCheckins'
import { getCurrentUser, formatName } from '../../utils/auth'
import { friendlyErrorMessage } from '../../utils/network'
import type { CheckinEventRow } from '../../types/app'

/**
 * Re-probe the member graph and top up the event's eligible list.
 *
 * Why this exists
 * ---------------
 * Check-in eligibility is answered entirely from the event's snapshot, taken
 * once at creation — no graph call happens during a live event. That is
 * deliberate (see utils/eventScopeSnapshot.ts), but it means the list is frozen
 * between probes: someone promoted to leader after the event was created is not
 * in it, and cannot check in.
 *
 * This replaces the old "add member to event scope" button, which patched one
 * person at a time and was superadmin-only. Re-running the same probe the
 * creation path uses is both less fiddly and less likely to drift from it.
 *
 * Additive only — see snapshotEventScopeFromGraph for why nobody is removed.
 */
export default function RefreshEligibleList({ event }: { event: CheckinEventRow }) {
  const user = getCurrentUser()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ added: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const isSpecialGroup = event.scope_level === 'special_group'

  async function handleRefresh() {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const { memberCount, previousCount } = await snapshotEventScopeFromGraph({
        eventId: event.id,
        groupIds: isSpecialGroup ? [event.scope_church_id] : [],
        scopes: isSpecialGroup
          ? []
          : [{ level: event.scope_level, id: event.scope_church_id }],
      })
      // memberCount is what the graph returned now; previousCount is what the
      // snapshot held before. The difference is what this run actually added,
      // and can be zero — which is a useful answer, not a failure.
      const added = Math.max(0, memberCount - previousCount)
      setResult({ added, total: Math.max(memberCount, previousCount) })
      addAuditLog({
        action: 'event.refresh_scope',
        actorId: user?.userId,
        actorName: user ? formatName(user) : 'Admin',
        eventId: event.id,
        details: { added, total: memberCount },
      }).catch(() => {})
    } catch (err: unknown) {
      setError(friendlyErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='flex flex-col gap-2'>
      <p className='m-0 text-xs leading-relaxed text-muted-foreground'>
        The eligible list is captured when the meeting is created, so check-in
        never depends on the member directory being reachable. Refresh it if
        someone has been given a role since then.
      </p>
      <Button
        type='button'
        variant='outline'
        disabled={busy}
        onClick={handleRefresh}
        className='w-full'
      >
        {busy ? 'Checking the directory…' : 'Refresh eligible list'}
      </Button>

      {result && (
        <Alert variant={result.added > 0 ? 'success' : 'default'}>
          {result.added > 0
            ? `Added ${result.added} newly eligible member${result.added > 1 ? 's' : ''} — ${result.total} in total.`
            : `Already up to date — ${result.total} eligible.`}
        </Alert>
      )}
      {error && <Alert variant='destructive'>{error}</Alert>}
    </div>
  )
}
