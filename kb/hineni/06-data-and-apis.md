# Hineni — data and APIs

## Supabase (`src/utils/supabaseCheckins.ts`)

Primary persistence for events and attendance.

| Area | Tables / concepts |
|------|-------------------|
| Events | `checkin_events` — status, scope, geofence, secrets, `is_public` |
| Records | `checkin_records` — a row = Present, no row = Absent; `checked_in_at` + method. (Checkout/late columns are legacy — unread.) |
| Profiles | `member_profiles` — face descriptor, hierarchy columns |
| Groups | `special_groups`, members junction |
| Audit | `checkin_audit_log` (append-only) |

Use **RPCs** for atomic check-in, device claim, PIN validation — do not bypass with raw inserts
unless mirroring an existing pattern.

Dashboard counters come from the `get_event_dashboard_stats` RPC (polled — no Realtime channel).

## FL member graph → Supabase (primary data flow)

See **[10-graph-to-supabase.md](10-graph-to-supabase.md)** — graph is source of truth; every login
re-probes scopes and upserts `member_profiles` + `churchContext` via `graphProfileSync.ts`.

## FLC GraphQL (`src/utils/membersApi.ts`)

**Same member graph as the FL Admin Portal** — church hierarchy, `leads*` / `isAdminFor*` edges,
and role-related fields. Hineni does not maintain a parallel directory; it queries the portal’s
GraphQL schema (proxied) for scopes, eligibility, and biometrics sync.

- Queries in `membersApi.queries.ts`
- Proxied at `/flc-graphql` (Vite / Vercel) — never call Lambda URL directly from browser
- Key helpers: `resolveCurrentMember`, `getAdminScopes`, `getMembersInScope`, `isLeaderOrAdmin`,
  `searchChurches`, `getAllLeadersAndAdmins`, `clearResolveCurrentMemberCache`

## Auth (`src/utils/auth.ts`)

- `loginWithCredentials`, `logout`, `getCurrentUser`, `enrichUser`
- Church context: `persistChurchContextFromJwt`, `persistChurchContextFromProfileRow`
- Login / refresh triggers `syncGraphProfileForUser` (see `graphProfileSync.ts`)

## Types

- `src/types/app.ts` — hand-written app types
- `src/types/supabase.ts` — optional generated types (`npm run codegen:supabase`)

## Environment (local dev)

| Variable | Purpose |
|----------|---------|
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Anon key |
| `VITE_MEMBER_GRAPHQL_URL` | GraphQL endpoint (proxied) |
| `VITE_AUTH_API_URL` | Auth Lambda (proxied) |

`net::ERR_NAME_NOT_RESOLVED` on Supabase = wrong URL / DNS / offline — not a UI bug.

## Codegen

```bash
npm run codegen:supabase   # types from Supabase
npm run codegen:graphql    # if GraphQL codegen configured
```
