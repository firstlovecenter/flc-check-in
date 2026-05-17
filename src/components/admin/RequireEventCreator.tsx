// Route gate for the create-event flow.
//
// Allows: admins (isAdmin) AND leaders at council level or above. Bacenta
// leaders and governorship leaders cannot create events per policy.
//
// The graph node would be the most authoritative source but it's async to
// fetch. We do a fast sync check on the JWT's churchScopes here so the
// route doesn't flash a loading state for the common case; the form
// itself (CreateEventForm) re-checks via getCreatorScopes(member, user)
// once the graph resolves.

import { Navigate } from 'react-router-dom'
import { getCurrentUser } from '../../utils/auth'
import { getUserAdminScopesFromJwt, getUserLeaderScopesFromJwt } from '../../utils/userScope'

const LEADER_CREATOR_LEVELS = new Set(['council', 'stream', 'campus', 'oversight', 'denomination'])

export default function RequireEventCreator({ children }) {
  const user = getCurrentUser()
  if (!user) return <Navigate to='/' replace />
  if (user.isSuperAdmin) return children
  if (user.isAdmin) return children

  // Leader edges at council level or above.
  const leaderScopes = getUserLeaderScopesFromJwt(user)
  if (leaderScopes.some((s) => LEADER_CREATOR_LEVELS.has(s.level))) return children

  // Admin edges (some members have admin role on JWT but isAdmin === false).
  if (getUserAdminScopesFromJwt(user).length > 0) return children

  return <Navigate to='/home' replace />
}
