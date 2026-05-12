import { useEffect, useState, type ReactNode } from 'react'
import { getCurrentPosition, pointInGeofence, haversineMeters } from '../../utils/geo'
import type { LatLng, CheckinEventRow } from '../../types/app'

type GuardState =
  | { status: 'loading' }
  | { status: 'denied'; error: string }
  | { status: 'outside'; position: LatLng; distance: number | null }
  | { status: 'ok'; position: LatLng }

interface Props {
  event?: Partial<CheckinEventRow> | null
  initialPosition?: LatLng | null
  children: ReactNode | ((position: LatLng) => ReactNode)
}

/** HOC: requests GPS, blocks render if outside fence. Passes `position` to children. */
export default function GeofenceGuard({ event, initialPosition = null, children }: Props) {
  const [state, setState] = useState<GuardState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const pos = initialPosition || await getCurrentPosition({ timeout: 15000 })
        if (cancelled) return
        if (!event) {
          setState({ status: 'ok', position: pos })
          return
        }
        const inside = pointInGeofence({ lat: pos.lat, lng: pos.lng }, event)
        if (!inside) {
          let distance = null
          if (event.geofence_type === 'circle') {
            distance = Math.round(
              haversineMeters(pos.lat, pos.lng, event.geofence_center_lat, event.geofence_center_lng)
              - (event.geofence_radius_m || 0)
            )
          }
          setState({ status: 'outside', position: pos, distance })
        } else {
          setState({ status: 'ok', position: pos })
        }
      } catch (err: any) {
        if (!cancelled) setState({ status: 'denied', error: err.message })
      }
    })()
    return () => { cancelled = true }
  }, [event, initialPosition])

  if (state.status === 'loading') {
    return <Centered><Card><p style={{ color: 'var(--muted)' }}>Acquiring GPS…</p></Card></Centered>
  }
  if (state.status === 'denied') {
    return (
      <Centered>
        <Card>
          <h2 className='text-lg font-semibold mb-2' style={{ color: 'var(--coral)' }}>Location required</h2>
          <p className='text-sm' style={{ color: 'var(--muted)' }}>
            We couldn't get your location: {state.error}
          </p>
          <p className='text-sm mt-2' style={{ color: 'var(--muted)' }}>
            Enable location permissions in your browser and reload.
          </p>
        </Card>
      </Centered>
    )
  }
  if (state.status === 'outside') {
    return (
      <Centered>
        <Card>
          <h2 className='text-lg font-semibold mb-2' style={{ color: 'var(--amber)' }}>You're not at the venue</h2>
          <p className='text-sm' style={{ color: 'var(--muted)' }}>
            {state.distance != null
              ? `You are about ${state.distance} m outside the check-in area.`
              : 'You are outside the check-in area.'}
            <br />Move closer and reload.
          </p>
        </Card>
      </Centered>
    )
  }
  return typeof children === 'function' ? children(state.position) : children
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className='min-h-dvh flex items-center justify-center px-4' style={{ background: 'var(--bg)' }}>
      {children}
    </div>
  )
}
function Card({ children }: { children: ReactNode }) {
  return (
    <div className='w-full max-w-md rounded-2xl p-6 text-center'
      style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
      {children}
    </div>
  )
}
