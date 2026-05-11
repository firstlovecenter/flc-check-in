import { Navigate } from 'react-router-dom'
import { getCurrentUser } from '../utils/auth'

export default function RequireAuth({ children }) {
  const user = getCurrentUser()
  if (!user) return <Navigate to='/' replace />
  return children
}
