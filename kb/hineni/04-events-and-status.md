# Hineni — events and status

## Event status (`EventStatus`)

`ACTIVE` | `PAUSED` | `ENDED` — `src/types/app.ts`.

| Status | Meaning |
|--------|---------|
| `ACTIVE` | Check-in allowed within time window (server `now()`) |
| `PAUSED` | Temporarily blocked — admin Resume |
| `ENDED` | Closed — no new check-ins (cron flips expired ACTIVE events) |

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

Attendance is **binary** — exactly two metrics, nothing else (product rule):

- **Present** — the member has a `checkin_records` row for the event
- **Absent** — expected (in scope + role-eligible) but no record

No still-in / left / checked-out / late / total-expected / percentage metrics.
Checkout and late tracking were removed entirely (migration 028): no location
heartbeat, and ending an event no longer closes records. Check-in **times**
are still shown prominently on member rows, reports, and CSV exports.
Present uses the success token; Absent uses destructive.

## Live updates

`EventDashboard` polls the `get_event_dashboard_stats` RPC (Postgres does the
counting; migration 027): creator 8s, admin 15s, monitor 30s, hidden tab 60s.
A separate 60s poll refreshes event status. There is no Realtime subscription.
