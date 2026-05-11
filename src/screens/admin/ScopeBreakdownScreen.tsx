import { useParams } from 'react-router-dom'
import ScopeBreakdown from '../../components/admin/ScopeBreakdown'

export default function ScopeBreakdownScreen() {
  const { eventId } = useParams()
  return <ScopeBreakdown eventId={eventId} />
}
