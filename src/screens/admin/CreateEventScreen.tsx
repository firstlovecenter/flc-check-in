import RequireAdmin from '../../components/admin/RequireAdmin'
import ScreenHeader from '../../components/ScreenHeader'
import CreateEventForm from '../../components/admin/CreateEventForm'
import { PageShell, PageMain } from '../../components/layout/PageShell'

export default function CreateEventScreen() {
  return (
    <RequireAdmin>
      <PageShell>
        <ScreenHeader title='New event' />
        <PageMain className='max-w-3xl'>
          <CreateEventForm />
        </PageMain>
      </PageShell>
    </RequireAdmin>
  )
}
