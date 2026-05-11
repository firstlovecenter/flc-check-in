import { useParams } from 'react-router-dom'
import EventDashboard from '../../components/admin/EventDashboard'

export default function EventDashboardScreen() {
  const { eventId } = useParams()
  return <EventDashboard eventId={eventId} />
}
