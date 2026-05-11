import { Navigate } from 'react-router-dom'
import { getCurrentUser } from '../../utils/auth'

export default function RequireAdmin({ children }) {
  const user = getCurrentUser()
  if (!user?.isAdmin) return <Navigate to='/home' replace />
  return children
}
