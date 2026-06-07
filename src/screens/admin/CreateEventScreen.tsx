import { Navigate } from 'react-router-dom'
import RequireAdmin from '../../components/admin/RequireAdmin'
import ScreenHeader from '../../components/ScreenHeader'
import CreateEventForm from '../../components/admin/CreateEventForm'
import { PageShell, PageMain } from '../../components/layout/PageShell'
import { getCurrentUser } from '../../utils/auth'

export default function CreateEventScreen() {
  const user = getCurrentUser()
  if (user?.isSuperViewer) return <Navigate to='/home' replace />
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
