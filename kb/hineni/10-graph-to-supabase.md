# Hineni — FL member graph → Supabase

## Why both systems exist

| System | Role |
|--------|------|
| **FL member graph** (GraphQL / Neo4j) | Source of truth for who someone is, `leads*` / `isAdminFor*` edges, and church hierarchy |
| **Supabase `member_profiles`** | Fast cache for Hineni: event visibility filters, dashboard joins, biometrics, offline-tolerant home screen |

Event **scopes** (which church an event belongs to) are chosen at create time from the graph (or superadmin church search). Event **eligibility** uses `event_scope_members` snapshots plus `allowed_roles`, often hydrated from the graph once then stored in Supabase.

## When the graph is probed

| Trigger | What runs |
|---------|-----------|
| **Password login** | `loginWithCredentials` → `syncGraphProfileForUser({ force: true })` |
| **Token refresh** (expired access token) | `refreshSession` → same forced sync |
| **Any authed route** | `RequireAuth` → background sync if last sync &gt; 30 min (same session) |
| **Home screen** | Extra hydration if JWT / profile row still missing ancestor IDs |
| **Create event** | `getMembersInScope` → `bulkUpsertMemberProfiles` + `snapshotEventScopeMembers` |
| **Superadmin Sync Members** | `getAllLeadersAndAdmins` → bulk upsert (directory-wide, not per-login) |

Implementation: `src/utils/graphProfileSync.ts`, `membersApi.resolveCurrentMember`, `memberToProfileRow`, `auth.persistChurchContext*`.

## What each login sync writes

1. **GraphQL** — `resolveCurrentMember` by auth `userId` and email (parallel).
2. **`member_profiles`** — upsert keyed by **auth `userId`**, not graph node id. Columns include `bacenta_id` … `denomination_id`, names, and **derived** `roles[]` from graph edges (`memberToProfileRow`).
3. **`localStorage churchContext`** — full ancestor chain from the profile row; JWT `churchScopes` merged as fallback.

Requires a valid **access token** on GraphQL. Visibility is whatever the FLC API allows for that JWT (not widened by Supabase `superadmins` alone).

## Bulk population (not login)

- **Sync Members** (`/admin/sync-members`) — superadmin pages the graph into many `member_profiles` rows.
- **Event creation** — all leaders/admins in the selected scope(s) snapshotted to `event_scope_members` + profiles upserted.

Hineni cannot change or extend the Graph schema. Its operational lifecycle is
therefore derived from current `leads*` / `isAdminFor*` relationships. The Graph
requires these active relationships to be removed before member deactivation.
Hineni stores current operational eligibility as `member_profiles.is_active`:

- active members are eligible for current directory searches and new event snapshots;
- members without current leadership/admin relationships remain cached for historical attendance, but are removed
  from open/future event snapshots and rejected by the server-side entry gate;
- only superadmins may run directory-wide reconciliation, preventing a scope-limited
  Graph response from falsely deactivating members outside the caller's visibility.

Regular members only land in Supabase when they **log in** (or are included in an event scope sync / admin add-member flow).

## Failure behaviour

Sync is **best-effort** and non-blocking on login (home may render from JWT first). Graph errors are logged; user can pull-to-refresh on home to retry hydration. Null graph match (wrong id / not in graph) still upserts JWT-shaped row so email and roles from auth are not lost.
