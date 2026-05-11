import RequireAdmin from '../../components/admin/RequireAdmin'
import ScreenHeader from '../../components/ScreenHeader'
import CreateEventForm from '../../components/admin/CreateEventForm'

export default function CreateEventScreen() {
  return (
    <RequireAdmin>
      <div className='min-h-dvh' style={{ background: 'var(--bg)' }}>
        <ScreenHeader title='New event' />
        <main className='max-w-3xl mx-auto px-4 sm:px-6 py-6'>
          <CreateEventForm />
        </main>
      </div>
    </RequireAdmin>
  )
}
