# Hineni — events and status

## Event status (`EventStatus`)

`ACTIVE` | `PAUSED` | `ENDED` — `src/types/app.ts`.

| Status | Meaning |
|--------|---------|
| `ACTIVE` | Check-in allowed within time window (server `now()`) |
| `PAUSED` | Temporarily blocked — admin Resume |
| `ENDED` | Closed — no new check-ins; cron may auto-checkout |

Admin actions (pause, resume, extend, end, reset PIN) → `CheckInAdminControls` + audit log.

## Scope

Each event has:

- `scope_level` — one of `SCOPE_LEVELS` (includes `special_group`)
- `scope_church_id` / `scope_church_name`
- `allowed_roles` — which leader/admin role strings may check in (e.g. `leaderBacenta`)

**Superadmin** can target multiple church scopes or a **special group** (saved member list).

## Viewer capabilities (`viewerCaps`)

Computed in `src/hooks/useEventEligibility.ts` — cached per event/user.

| Field | Typical meaning |
|-------|-----------------|
| `canManage` | Admin of event scope — edit, audit, manual check-in, controls |
| `canCheckIn` | May check self in (leader in scope or special-group member) |
| `canView` | May see dashboard/report for their slice |
| `canManuallyCheckIn` | Admin + on-site manual check-in (not leader-self) |
| `viewerScope` | `{ level, id, name }` for non-admin leaders |

**Redirects:**

- Lowest allowed role in event → straight to `/checkin/:id` (no empty dashboard).
- Bacenta-only leaders / special-group members → check-in or home when appropriate.

## Dashboard stats (contract)

- **Still in** — checked in, not checked out
- **Left** — checked out
- **Absent** — eligible, no record
- **Total expected** — eligible in viewer slice

Attendance % uses attended vs total; status colors use success / warning / destructive tokens.

## Realtime

`EventDashboard` subscribes to Supabase `postgres_changes` on `checkin_records` for live updates;
60s poll refreshes event status.
