import { Navigate } from 'react-router-dom'
import RequireAuth from '../../components/RequireAuth'
import ScreenHeader from '../../components/ScreenHeader'
import CreateEventForm from '../../components/admin/CreateEventForm'
import { PageShell, PageMain } from '../../components/layout/PageShell'
import { canCreateMeetings, getCurrentUser } from '../../utils/auth'

export default function CreateEventScreen() {
  const user = getCurrentUser()
  if (user?.isSuperViewer) return <Navigate to='/home' replace />
  if (!canCreateMeetings(user)) return <Navigate to='/home' replace />
  return (
    <RequireAuth>
      <PageShell>
        <ScreenHeader title='New event' />
        <PageMain className='max-w-3xl'>
          <CreateEventForm />
        </PageMain>
      </PageShell>
    </RequireAuth>
  )
}
