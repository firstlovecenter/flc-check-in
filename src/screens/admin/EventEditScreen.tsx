import { useParams } from 'react-router-dom'
import ScreenHeader from '../../components/ScreenHeader'
import RequireAdmin from '../../components/admin/RequireAdmin'
import EventEditForm from '../../components/admin/EventEditForm'

export default function EventEditScreen() {
  const { eventId } = useParams()
  return (
    <RequireAdmin>
      <div className='min-h-dvh' style={{ background: 'var(--bg)' }}>
        <ScreenHeader
          title='Edit event'
          back={{ to: `/events/${eventId}`, label: 'Dashboard' }}
        />
        <main className='max-w-3xl mx-auto px-4 sm:px-6 py-6'>
          <EventEditForm eventId={eventId} />
        </main>
      </div>
    </RequireAdmin>
  )
}
