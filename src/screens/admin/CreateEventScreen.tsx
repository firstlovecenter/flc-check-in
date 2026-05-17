import RequireEventCreator from '../../components/admin/RequireEventCreator'
import ScreenHeader from '../../components/ScreenHeader'
import CreateEventForm from '../../components/admin/CreateEventForm'

export default function CreateEventScreen() {
  return (
    <RequireEventCreator>
      <div className='min-h-dvh' style={{ background: 'var(--bg)' }}>
        <ScreenHeader title='New event' />
        <main className='max-w-3xl mx-auto px-4 sm:px-6 py-6'>
          <CreateEventForm />
        </main>
      </div>
    </RequireEventCreator>
  )
}
