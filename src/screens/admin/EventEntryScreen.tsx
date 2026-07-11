import { useEffect, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import Spinner from '../../components/Spinner'
import { Alert } from '../../components/ui/alert'
import { getCurrentUser } from '../../utils/auth'
import {
  loadEventEntryState,
  resolveEventEntryRoute,
  type EventEntryRoute,
  type EventEntryState,
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
  const user = getCurrentUser()
  const [state, setState] = useState<GateState>({ status: 'loading' })

  useEffect(() => {
    if (!eventId || !user) return
    let cancelled = false

    ;(async () => {
      setState({ status: 'loading' })
      try {
        const entry = await loadEventEntryState(eventId, user)
        if (cancelled) return
        const route = resolveEventEntryRoute(user, entry)
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
  }, [eventId, user?.userId, user?.email])

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
