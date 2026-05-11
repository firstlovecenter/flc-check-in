import { useParams } from 'react-router-dom'
import FullReport from '../../components/admin/FullReport'

export default function FullReportScreen() {
  const { eventId } = useParams()
  return <FullReport eventId={eventId} />
}
