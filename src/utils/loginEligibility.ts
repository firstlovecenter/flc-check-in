import type { AppUser } from '../types/app'
import {
  clearResolveCurrentMemberCache,
  isLeaderOrAdmin,
  resolveCurrentMember,
} from './membersApi'
import { persistResolvedGraphProfileForUser } from './graphProfileSync'

const ACCESS_ROLE = /^(leader|admin)(Bacenta|Governorship|Council|Stream|Campus|Oversight|Denomination)$/

type EligibilitySource =
  | 'superadmin'
  | 'member-graph'
  | 'auth-degraded'

export interface LoginEligibilityResult {
  eligible: boolean
  source: EligibilitySource
}

export function hasLeaderOrAdminRole(roles: unknown): boolean {
  return Array.isArray(roles) && roles.some(
    (role) => typeof role === 'string' && ACCESS_ROLE.test(role),
  )
}

/**
 * Verify the minimum leader/admin login gate.
 *
 * The graph remains authoritative. resolveCurrentMember combines auth ID and
 * email in one GraphQL query. Profile persistence runs only after the graph
 * grants access and cannot change the authorization result. A graph outage
 * retains the existing degraded behaviour for a fresh auth leader/admin role.
 */
export async function verifyLoginEligibility(user: AppUser): Promise<LoginEligibilityResult> {
  if (user.isSuperAdmin) return { eligible: true, source: 'superadmin' }

  const authEligible = hasLeaderOrAdminRole(user.roles)

  let member: any | null
  try {
    clearResolveCurrentMemberCache(user)
    member = await resolveCurrentMember(user)
  } catch (error) {
    if (!authEligible) throw error
    return { eligible: true, source: 'auth-degraded' }
  }

  if (!isLeaderOrAdmin(member)) {
    return { eligible: false, source: 'member-graph' }
  }

  // The authoritative decision is complete. Cache/profile persistence is
  // best-effort and must not delay or alter login authorization.
  persistResolvedGraphProfileForUser(user, member).catch((error) => {
    console.warn('[loginEligibility] profile persistence failed:', error?.message || error)
  })
  return { eligible: true, source: 'member-graph' }
}
