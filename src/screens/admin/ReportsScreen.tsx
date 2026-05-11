import RequireAdmin from '../../components/admin/RequireAdmin'
import ReportsList from '../../components/admin/ReportsList'

export default function ReportsScreen() {
  return (
    <RequireAdmin>
      <ReportsList />
    </RequireAdmin>
  )
}
