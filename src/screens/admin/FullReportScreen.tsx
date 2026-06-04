import { useParams } from 'react-router-dom'
import FullReport from '../../components/admin/FullReport'
import { CenterCard } from '../../components/layout/CenterCard'

export default function FullReportScreen() {
  const { eventId } = useParams()
  if (!eventId) {
    return (
      <CenterCard>
        <p className='text-muted-foreground'>Event not found.</p>
      </CenterCard>
    )
  }
  return <FullReport eventId={eventId} />
}
