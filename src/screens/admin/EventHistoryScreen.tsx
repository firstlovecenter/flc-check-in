import RequireAdmin from '../../components/admin/RequireAdmin'
import EventHistoryList from '../../components/admin/EventHistoryList'

export default function EventHistoryScreen() {
  return (
    <RequireAdmin>
      <EventHistoryList />
    </RequireAdmin>
  )
}
