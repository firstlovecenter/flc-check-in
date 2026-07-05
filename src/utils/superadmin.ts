// Hineni superadmin — bypass JWT church-scope and allowed_roles limits in this app.
//
// `isSuperAdmin` is set when the JWT contains `superAdmin`, the email is in
// Supabase `superadmins` (via local override), OR the user has the
// `adminDenomination` role (policy elevation in auth.ts).
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
