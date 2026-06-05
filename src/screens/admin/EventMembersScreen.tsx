import { useParams } from 'react-router-dom'
import EventMembers from '../../components/admin/EventMembers'

export default function EventMembersScreen() {
  const { eventId } = useParams<{ eventId: string }>()
  return <EventMembers eventId={eventId!} />
}
