import RequireAdmin from '../../components/admin/RequireAdmin'
import MemberBiometrics from '../../components/admin/MemberBiometrics'

export default function MemberSearchScreen() {
  return (
    <RequireAdmin>
      <MemberBiometrics />
    </RequireAdmin>
  )
}
