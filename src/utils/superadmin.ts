// Hineni superadmin — bypass JWT church-scope and allowed_roles limits in this app.
//
// `isSuperAdmin` is set when the JWT contains `superAdmin` OR the email is in
// Supabase `superadmins` (see auth.ts `superAdminOverride`).
//
// GraphQL reads still require a valid bearer token; cross-scope graph visibility
// depends on the FLC API honouring the `superAdmin` JWT role. Supabase writes
// use permissive anon policies — Hineni does not scope-filter SA mutations.

import type { AppUser } from '../types/app'

export function isAppSuperAdmin(user?: AppUser | null): boolean {
  return !!user?.isSuperAdmin
}

export function isAppSuperViewer(user?: AppUser | null): boolean {
  return !!user?.isSuperViewer
}

/** True when callers should skip JWT / churchScopes / allowed_roles gating.
 *  Both superAdmin and superViewer bypass scope/role filters for reads. */
export function bypassesScopeAndRoleLimits(user?: AppUser | null): boolean {
  return isAppSuperAdmin(user) || isAppSuperViewer(user)
}
