import Spinner from '../Spinner'
import { useRotatingPin } from '../../hooks/useRotatingPin'
import type { CheckinEventRow } from '../../types/app'

// Shows the event's current rotating PIN on the check-in page so a member who
// is already at the venue can read it directly instead of hunting for the
// projected QR/PIN display. This only renders inside the GeofenceGuard (the
// member is confirmed on-site), and the same PIN is shown publicly on the
// /events display, so it exposes nothing new.
export default function RotatingPinDisplay({ event }: { event: CheckinEventRow }) {
  const { pin, secsLeft } = useRotatingPin(event)

  return (
    <div className='rounded-xl border border-border bg-secondary p-4 text-center'>
      <p className='section-heading m-0 mb-2'>Event PIN</p>
      {pin ? (
        <p className='tnum m-0 text-4xl font-bold tracking-[0.25em] text-foreground'>{pin}</p>
      ) : (
        <Spinner />
      )}
      <p className='m-0 mt-2 text-xs text-muted-foreground'>rotates in {secsLeft}s</p>
    </div>
  )
}
