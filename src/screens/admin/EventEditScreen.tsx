import { useParams } from 'react-router-dom'
import ScreenHeader from '../../components/ScreenHeader'
import RequireAdmin from '../../components/admin/RequireAdmin'
import EventEditForm from '../../components/admin/EventEditForm'
import { PageShell, PageMain } from '../../components/layout/PageShell'

export default function EventEditScreen() {
  const { eventId } = useParams()
  return (
    <RequireAdmin>
      <PageShell>
        <ScreenHeader title='Edit event' back={{ to: `/events/${eventId}`, label: 'Dashboard' }} />
        <PageMain className='max-w-3xl'>
          <EventEditForm eventId={eventId} />
        </PageMain>
      </PageShell>
    </RequireAdmin>
  )
}
