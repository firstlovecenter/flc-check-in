import { useEffect, useState } from 'react'
import { Navigate, useParams, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import Spinner from '../../components/Spinner'
import { Alert } from '../../components/ui/alert'
import { getCurrentUser } from '../../utils/auth'
import { useChurchFocus } from '../../contexts/ChurchFocusContext'
import {
  loadEventEntryState,
  resolveEventEntryRoute,
  capsForEntry,
  type EventEntryRoute,
  type EventEntryState,
} from '../../utils/eventEntryGate'
import type { ViewerCaps } from '../../utils/eventCaps'
import { friendlyErrorMessage } from '../../utils/network'
import EventDashboard from '../../components/admin/EventDashboard'
import WrongHatNotice from '../../components/checkin/WrongHatNotice'

type GateState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'route'; route: EventEntryRoute }
  | { status: 'dashboard'; caps: ViewerCaps | null }
  | { status: 'no-access'; entry: EventEntryState }

/** Cheap snapshot gate before any dashboard eligibility fan-out.
 *
 *  Routing is decided by the hat the user is CURRENTLY wearing, not by the
 *  highest role they hold anywhere — see utils/eventEntryGate.ts for why that
 *  distinction is the whole point. Switching hats re-runs the gate, so a user
 *  who lands somewhere unexpected can correct it without leaving the screen. */
export default function EventEntryScreen() {
  const { t } = useTranslation()
  const { eventId } = useParams()
  const [searchParams] = useSearchParams()
  const user = getCurrentUser()
  const { focusedHat } = useChurchFocus()
  const [state, setState] = useState<GateState>({ status: 'loading' })

  // ScopeBreakdown → `/events/:id?scopeLevel=&scopeChurchId=` is a dashboard
  // drill-down, not a fresh event open. Skip the check-in redirect for those.
  const hasScopeDrilldown = !!(
    searchParams.get('scopeLevel') && searchParams.get('scopeChurchId')
  )

  useEffect(() => {
    if (!eventId || !user) return
    let cancelled = false

    ;(async () => {
      setState({ status: 'loading' })
      try {
        // Run the gate even for drill-downs. It is one cheap Postgres RPC, and
        // it means capsOverride is ALWAYS supplied to the dashboard — which is
        // what lets useEventEligibility drop its graph-backed capability
        // cascade entirely. Previously drill-downs passed caps: null and fell
        // through to that cascade, so the Neo4j path stayed alive for them.
        const entry = await loadEventEntryState(eventId, user, focusedHat)
        if (cancelled) return

        const caps = capsForEntry(user, focusedHat, entry)
        // This hat gives the user nothing here — but another of their hats
        // might. Say so plainly instead of showing an empty dashboard.
        if (entry.found && !caps.canView && !caps.canCheckIn && !caps.canManage) {
          setState({ status: 'no-access', entry })
          return
        }

        const route = resolveEventEntryRoute(user, focusedHat, entry, { hasScopeDrilldown })
        setState(route === 'dashboard' ? { status: 'dashboard', caps } : { status: 'route', route })
      } catch (err: any) {
        if (!cancelled) setState({ status: 'error', error: friendlyErrorMessage(err) })
      }
    })()

    return () => { cancelled = true }
    // focusedHat.key in the deps: switching hats must re-decide the route.
  }, [eventId, user?.userId, user?.email, hasScopeDrilldown, focusedHat?.key])

  if (!user) return null
  if (!eventId) return <Alert variant='destructive'>{t('events.missingEvent')}</Alert>

  if (state.status === 'loading') {
    return <Spinner fullPage message={t('checkin.loadingEvent')} />
  }

  if (state.status === 'error') {
    return (
      <div className='mx-auto max-w-md px-5 py-10'>
        <Alert variant='destructive'>{state.error}</Alert>
      </div>
    )
  }

  if (state.status === 'no-access') {
    return <WrongHatNotice scopeChurchName={state.entry.scopeChurchName} />
  }

  if (state.status === 'route' && state.route === 'checkin') {
    return <Navigate to={`/checkin/${eventId}`} replace />
  }

  if (state.status === 'route' && state.route === 'home') {
    return <Navigate to='/home' replace />
  }

  // Hand the already-resolved capabilities down so the dashboard does not
  // re-derive them through the legacy cascade (and its Neo4j calls).
  return <EventDashboard eventId={eventId} capsOverride={state.status === 'dashboard' ? state.caps : null} />
}
