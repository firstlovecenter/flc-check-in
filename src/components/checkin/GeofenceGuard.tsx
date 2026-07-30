import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { getCurrentPosition, pointInGeofence, haversineMeters } from '../../utils/geo'
import type { LatLng, CheckinEventRow } from '../../types/app'
import Spinner from '../Spinner'
import { PageShell } from '../layout/PageShell'
import { Card, CardContent } from '../ui/card'

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
  const { t } = useTranslation()
  const [state, setState] = useState<GuardState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const pos = initialPosition || (await getCurrentPosition({ timeout: 15000 }))
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
              haversineMeters(pos.lat, pos.lng, event.geofence_center_lat!, event.geofence_center_lng!) -
                (event.geofence_radius_m || 0),
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
    return (
      <Centered>
        <Card className='w-full max-w-md text-center'>
          <CardContent className='flex flex-col items-center gap-3 p-6'>
            <Spinner fullPage={false} />
            <p className='m-0 text-sm text-muted-foreground'>{t('checkin.geofence.acquiringGps')}</p>
          </CardContent>
        </Card>
      </Centered>
    )
  }
  if (state.status === 'denied') {
    return (
      <Centered>
        <Card className='w-full max-w-md text-center'>
          <CardContent className='p-6'>
            <h2 className='mb-2 text-lg font-semibold text-destructive'>{t('checkin.geofence.locationRequired')}</h2>
            <p className='text-sm text-muted-foreground'>
              {t('checkin.geofence.locationError', { error: state.error })}
            </p>
            <p className='mt-2 text-sm text-muted-foreground'>
              {t('checkin.geofence.enableLocation')}
            </p>
          </CardContent>
        </Card>
      </Centered>
    )
  }
  if (state.status === 'outside') {
    return (
      <Centered>
        <Card className='w-full max-w-md text-center'>
          <CardContent className='p-6'>
            <h2 className='mb-2 text-lg font-semibold text-warning'>{t('checkin.geofence.notAtVenue')}</h2>
            <p className='text-sm text-muted-foreground'>
              {state.distance != null
                ? t('checkin.geofence.outsideDistance', { distance: state.distance })
                : t('checkin.geofence.outsideArea')}
              <br />
              {t('checkin.geofence.moveCloser')}
            </p>
          </CardContent>
        </Card>
      </Centered>
    )
  }
  return typeof children === 'function' ? children(state.position) : children
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <PageShell className='items-center justify-center px-4'>{children}</PageShell>
  )
}
