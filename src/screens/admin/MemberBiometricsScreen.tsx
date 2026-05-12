import RequireAdmin from '../../components/admin/RequireAdmin'
import MemberBiometrics from '../../components/admin/MemberBiometrics'

export default function MemberBiometricsScreen() {
  return (
    <RequireAdmin>
      <MemberBiometrics />
    </RequireAdmin>
  )
}
