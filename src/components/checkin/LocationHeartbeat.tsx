import { useEffect } from 'react'
import { watchPositionThrottled } from '../../utils/geo'
import { reportLocation } from '../../utils/supabaseCheckins'

/** Effect-only: every 60s, fetch GPS and call report_member_location.
 *  Server decides whether the leader gets auto-checked-out.
 *  onCheckedOut is called when the server reports a checkout. */
export default function LocationHeartbeat({ eventId, memberId, onCheckedOut, intervalMs = 60000 }) {
  useEffect(() => {
    if (!eventId || !memberId) return
    const stop = watchPositionThrottled(
      async (pos) => {
        try {
          const result = await reportLocation(eventId, memberId, pos.lat, pos.lng)
          if (result?.checked_out) onCheckedOut?.(result)
        } catch (err: any) {
          console.warn('[heartbeat] reportLocation failed:', err.message)
        }
      },
      (err) => console.warn('[heartbeat] GPS error:', err.message),
      intervalMs,
    )
    return stop
  }, [eventId, memberId, onCheckedOut, intervalMs])
  return null
}
