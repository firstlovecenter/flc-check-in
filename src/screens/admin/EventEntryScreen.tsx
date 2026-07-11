import { useEffect, useState } from 'react'
import { Navigate, useParams, useSearchParams } from 'react-router-dom'
import Spinner from '../../components/Spinner'
import { Alert } from '../../components/ui/alert'
import { getCurrentUser } from '../../utils/auth'
import {
  loadEventEntryState,
  resolveEventEntryRoute,
  type EventEntryRoute,
} from '../../utils/eventEntryGate'
import { friendlyErrorMessage } from '../../utils/network'
import EventDashboard from '../../components/admin/EventDashboard'

type GateState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'route'; route: EventEntryRoute }
  | { status: 'dashboard' }

/** Cheap snapshot gate before any dashboard eligibility fan-out. */
export default function EventEntryScreen() {
  const { eventId } = useParams()
  const [searchParams] = useSearchParams()
  const user = getCurrentUser()
  const [state, setState] = useState<GateState>({ status: 'loading' })

  // ScopeBreakdown → `/events/:id?scopeLevel=&scopeChurchId=` is a dashboard
  // drill-down, not a fresh event open. Skip the check-in redirect for those.
  const hasScopeDrilldown = !!(
    searchParams.get('scopeLevel') && searchParams.get('scopeChurchId')
  )

  useEffect(() => {
    if (!eventId || !user) return
    let cancelled = false

    // Drill-downs never need the entry RPC — go straight to the dashboard.
    if (hasScopeDrilldown) {
      setState({ status: 'dashboard' })
      return
    }

    ;(async () => {
      setState({ status: 'loading' })
      try {
        const entry = await loadEventEntryState(eventId, user)
        if (cancelled) return
        const route = resolveEventEntryRoute(user, entry, { hasScopeDrilldown })
        if (route === 'dashboard') {
          setState({ status: 'dashboard' })
        } else {
          setState({ status: 'route', route })
        }
      } catch (err: any) {
        if (!cancelled) setState({ status: 'error', error: friendlyErrorMessage(err) })
      }
    })()

    return () => { cancelled = true }
  }, [eventId, user?.userId, user?.email, hasScopeDrilldown])

  if (!user) return null
  if (!eventId) return <Alert variant='destructive'>Missing event.</Alert>

  if (state.status === 'loading') return <Spinner fullPage />

  if (state.status === 'error') {
    return (
      <div className='mx-auto max-w-md px-5 py-10'>
        <Alert variant='destructive'>{state.error}</Alert>
      </div>
    )
  }

  if (state.status === 'route' && state.route === 'checkin') {
    return <Navigate to={`/checkin/${eventId}`} replace />
  }

  if (state.status === 'route' && state.route === 'home') {
    return <Navigate to='/home' replace />
  }

  return <EventDashboard eventId={eventId} />
}
