import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import ScreenHeader from '../../components/ScreenHeader'
import RequireAdmin from '../../components/admin/RequireAdmin'
import EventEditForm from '../../components/admin/EventEditForm'
import { PageShell, PageMain } from '../../components/layout/PageShell'

export default function EventEditScreen() {
  const { t } = useTranslation()
  const { eventId } = useParams()
  return (
    <RequireAdmin>
      <PageShell>
        <ScreenHeader title={t('events.editScreenTitle')} back={{ to: `/events/${eventId}`, label: t('events.editScreenBack') }} />
        <PageMain className='max-w-3xl'>
          <EventEditForm eventId={eventId} />
        </PageMain>
      </PageShell>
    </RequireAdmin>
  )
}
