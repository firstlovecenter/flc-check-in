# Hineni — auth and roles

Roles and church scope are **not Hineni-specific**. They match the **FL Admin Portal** member
graph and JWT (see [00-church-structure.md](00-church-structure.md), [kb/02-user-roles.md](../02-user-roles.md)).
This file describes **how Hineni applies** those roles in this app.

## Auth flow

1. User signs in on `/` → `LoginScreen` → `loginWithCredentials()` in `src/utils/auth.ts`.
2. FLC auth Lambda (proxied as `/api/flc-auth`) returns JWT + optional church refs.
3. Token stored in `sessionStorage`; `getCurrentUser()` decodes JWT and merges `churchContext`
   from `localStorage` when graph hydration is stale.
4. **Login gate:** `resolveCurrentMember()` + `isLeaderOrAdmin(member)` in `membersApi.ts`.
   Non-leaders are logged out and redirected with `?notLeader=1`.
5. **Superadmin:** `user.isSuperAdmin` when JWT has `superAdmin` **or** email is in Supabase
   `superadmins` (`is_super_admin` RPC at login). Superadmins:
   - Skip the login leader/admin graph gate (`LoginScreen`).
   - Bypass **Hineni** JWT church-scope filters (events, home list, biometrics) and
     `allowed_roles` eligibility on dashboards.
   - Use graph search / church picker / Sync Members without `getAdminScopes()` limits.
   - **GraphQL** still needs a bearer token; cross-scope reads require the FLC API to honour
     `superAdmin` on that JWT (Supabase-table-only SA grants Hineni UI, not wider graph ACLs).
   - **Supabase** client writes are not scope-filtered in app code (anon policies are permissive;
     destructive RPCs like `delete_event` check `superadmins` by email).

## AppUser flags (Hineni-specific)

Defined in `src/types/app.ts`, set in `enrichUser()` (`auth.ts`):

| Field | Meaning |
|-------|---------|
| `roles` | Raw JWT role strings |
| `level` | Highest scope level inferred from roles (bacenta → denomination) |
| `isAdmin` | Any `admin*` role or superadmin — gates `/admin/*` via `RequireAdmin` |
| `isSuperAdmin` | `superAdmin` in JWT |
| `churchScopes` | JWT object: `leads*Of`, `isAdminFor*Of` per level |

Portal `permitLeader()` / `permitAdmin()` helpers live in the monorepo’s `permission-utils.ts` —
Hineni enforces the **same role semantics** via `isLeaderOrAdmin`, `getAdminScopes`, `viewerCaps`,
and JWT flags instead of calling those helpers.

## Leader vs admin (same roles as portal; Hineni enforcement)

| Concept | Code | Powers |
|---------|------|--------|
| **Leader** | `leads*` edges on graph | Check in to events in scope; view dashboard for their slice |
| **Admin** | `isAdminFor*` edges (or JWT fallback) | Create/edit events, reports, biometrics, manual check-in |
| **Superadmin** | JWT `superAdmin` and/or `superadmins` table | All events, any church scope, sync/probe graph → Supabase, special groups |

`getAdminScopes(member, user)` (`membersApi.ts`) — scopes for **creating** events (admin edges only,
plus JWT `churchScopes` fallback for test accounts).

`isLeaderOrAdmin(member)` — minimum bar to use the app at all.

## RequireAdmin

`src/components/admin/RequireAdmin.tsx` — redirects to `/home` if `!user.isAdmin`.

Used by: Reports, History wrapper screens. Other admin routes rely on `RequireAuth` + in-screen
checks (`viewerCaps.canManage`, `isSuperAdmin`).

## Terminology

- Hierarchy and role names: [kb/01-glossary.md](../01-glossary.md), [kb/02-user-roles.md](../02-user-roles.md).
- Event scope levels: `SCOPE_LEVELS` in `src/types/app.ts` — all portal graph levels plus
  `special_group` (saved cross-church lists in Supabase, not a new tier on the church tree).
