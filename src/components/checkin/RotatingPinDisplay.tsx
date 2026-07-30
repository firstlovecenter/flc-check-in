import { useTranslation } from 'react-i18next'
import Spinner from '../Spinner'
import { useRotatingPin } from '../../hooks/useRotatingPin'
import { useEventDisplaySecret } from '../../hooks/useEventDisplaySecret'
import type { CheckinEventRow } from '../../types/app'

// Shows the event's current rotating PIN on the check-in page so a member who
// is already at the venue can read it directly instead of hunting for the
// projected QR/PIN display. This only renders inside the GeofenceGuard (the
// member is confirmed on-site), and the same PIN is shown publicly on the
// /events display, so it exposes nothing new.
export default function RotatingPinDisplay({ event }: { event: CheckinEventRow }) {
  const { t } = useTranslation()
  // The secret is no longer carried on the event row (see migration 038) —
  // request it for this screen, which legitimately displays a code.
  const secretHex = useEventDisplaySecret(event.id)
  const { pin, secsLeft } = useRotatingPin({ id: event.id, qr_secret_hex: secretHex })

  return (
    <div className='rounded-xl border border-border bg-secondary p-4 text-center'>
      <p className='section-heading m-0 mb-2'>{t('checkin.rotatingPin.label')}</p>
      {pin ? (
        <p className='tnum m-0 text-4xl font-bold tracking-[0.25em] text-foreground'>{pin}</p>
      ) : (
        <Spinner />
      )}
      <p className='m-0 mt-2 text-xs text-muted-foreground'>{t('checkin.rotatingPin.rotatesIn', { seconds: secsLeft })}</p>
    </div>
  )
}
