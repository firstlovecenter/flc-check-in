import { useParams } from 'react-router-dom'
import AuditLog from '../../components/admin/AuditLog'

export default function AuditLogScreen() {
  const { eventId } = useParams()
  return <AuditLog eventId={eventId!} />
}
