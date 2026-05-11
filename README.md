# FLC Check-In

Geofenced, time-windowed leader check-in for First Love Church. React +
Vite + Tailwind frontend, Supabase backend, FLC member GraphQL for
identity and hierarchy.

## Status

v1 — QR + PIN + Manual admin check-in. Face ID is deferred to v1.1.

## Stack

| Layer | Tech |
|---|---|
| UI | React 19 + Vite 8 + Tailwind 4 + React Router 7 |
| Auth | FLC Lambda (`VITE_AUTH_API_URL`) — JWT |
| Member directory | FLC GraphQL (`VITE_MEMBER_GRAPHQL_URL`) via `graphql-request` |
| Data | Supabase Postgres (free tier) |
| Auto-checkout | Supabase Edge Function on a 1-minute cron schedule |
| Map | Leaflet + OpenStreetMap (no API key) |
| QR | `qrcode` (display) + `@zxing/browser` (scan) |
| PIN | bcryptjs (browser) + pgcrypto (server) — 5 attempts/10 min → 15 min lockout |
| Device fingerprint | `@fingerprintjs/fingerprintjs` — one device per member per event |

## Local development

```bash
npm install
npm run dev   # http://localhost:3000
```

### Required env vars

In `.env`:
```
VITE_AUTH_API_URL=https://rgldisl2bxl3l2upaauxodtrhy0uxkot.lambda-url.eu-west-2.on.aws/auth
VITE_MEMBER_GRAPHQL_URL=https://dev-api-synago.firstlovecenter.com/graphql
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_<...>
```

Optional (only if you have the Supabase CLI installed and want to deploy the
edge function from this machine):
```
SUPABASE_ACCESS_TOKEN=sbp_<your-personal-access-token>
```

## First-time Supabase setup

1. Create a new Supabase project. Paste the URL + publishable key into `.env`.
2. **SQL editor** → paste `supabase/checkins_schema.sql` → Run. This creates
   all 5 tables, RPCs, helper functions, and disables RLS.
   (RLS is intentionally off; atomicity comes from the security-definer RPCs.)
3. Verify the schema works end-to-end:
   ```bash
   node supabase/smoke_test.mjs
   ```
   Should print 17 ✓ checks and "smoke test PASSED".
4. Deploy the auto-checkout Edge Function — see
   `supabase/functions/auto-checkout/README.md`.

## App structure

```
src/
  App.jsx                    Routes
  main.jsx
  index.css                  Theme tokens (--bg, --card, --accent, …)
  screens/
    LoginScreen.jsx          Email/password + demo modes; gates non-leaders out
    LeaderHomeScreen.jsx     "Active events at my GPS"
    QRDisplayScreen.jsx      Shared QR display at venue (/qr)
    CheckInFormScreen.jsx    Per-event form: QR scan, PIN, geofence guard, heartbeat
    admin/
      CreateEventScreen.jsx
      EventDashboardScreen.jsx
      CheckedInListScreen.jsx
      DefaultedListScreen.jsx
      ScopeBreakdownScreen.jsx
      ReportsScreen.jsx
      EventHistoryScreen.jsx
  components/
    TopBar.jsx               Greeting + admin link + logout
    Placeholder.jsx          (Used during scaffolding)
    fields/                  Generic AttendanceField, NoteField, …
    checkin/
      EventCardForLeader.jsx
      GeofenceGuard.jsx      HOC: requests GPS, blocks if outside fence
      QRScanner.jsx          @zxing/browser camera reader
      QRCodeDisplay.jsx      qrcode → canvas
      PinEntry.jsx           6-digit input with rate-limit feedback
      LocationHeartbeat.jsx  60s ReportLocation tick while checked in
    admin/
      RequireAdmin.jsx       Route guard
      CreateEventForm.jsx    Multi-section form (uses GeoFencePicker)
      GeoFencePicker.jsx     Leaflet map: circle + polygon modes
      EventDashboard.jsx     Live stats + QR + admin controls
      CheckInAdminControls.jsx  Pause / Resume / Extend / Reset PIN / End
      CheckedInList.jsx
      DefaultedList.jsx
      ManualCheckInModal.jsx
      ScopeBreakdown.jsx
      ReportsList.jsx        CSV export via papaparse
      EventHistoryList.jsx
  utils/
    auth.js                  JWT decode, role→level, login, demo, MOCK_USER
    supabase.js              Supabase client
    supabaseCheckins.js      Every check-in DB call routes through here
    membersApi.js            FLC GraphQL adapter (leaders/admins only)
    membersApi.queries.js    GraphQL query strings (one per scope level)
    geo.js                   Haversine, polygon, GPS wrappers
    checkinsCrypto.js        PIN/QR helpers (bcryptjs + WebCrypto HMAC)
    deviceFingerprint.js     FingerprintJS singleton
  legacy/                    Archived PVCIO Monitor code (not wired into routing)
supabase/
  checkins_schema.sql        Apply this once in the Supabase SQL editor
  checkins_schema_fix_001.sql First-run patch (RLS off + pgcrypto schema)
  smoke_test.mjs             Phase 1 RPC smoke test
  functions/
    auto-checkout/           Edge Function for time-based auto-checkout
scripts/
  introspect_flc.mjs         (Dev) GraphQL introspection helpers
  test_members_api.mjs       (Dev) GraphQL adapter live test
```

## Hierarchy + roles

The 7 FLC scope levels, lowest to highest:
`bacenta → governorship → council → stream → campus → oversight → denomination`

The app's universe is members who have at least one `leads*` or
`isAdminFor*` relationship in the FLC member graph — regular members
without leadership relationships are blocked at login.

Admins (`adminStream`, `adminCouncil`, etc.) can create events at their
level and any level below it — `getAdminScopes(member)` aggregates every
`leads*`/`isAdminFor*` edge a member holds.

## Anti-fraud (matches PDF spec)

- **Geofence** — every check-in path validates client-side (instant feedback)
  and server-side (`point_in_event_geofence` RPC). Cannot be bypassed.
- **Rotating QR** — HMAC-SHA256 with 60-second time bucket. Server accepts
  current and previous bucket so a scan during rotation isn't rejected.
- **PIN rate-limit** — 5 wrong attempts in 10 min → 15-min lockout.
  Enforced atomically in the `record_pin_attempt` RPC.
- **Device fingerprint** — one fingerprint per member per event, claimed
  atomically via `claim_device_for_event` RPC.
- **Manual check-in by admin** — also geofence-enforced; admin must be
  on-site, supplies a written reason.

## Test plan

End-to-end smoke (one admin device + two leader devices, all at same location):

1. Admin → `/admin/events/new` → create event (scope = your bacenta, ends
   in 1h, methods QR+PIN, circle 50m geofence around current GPS).
2. Leader 1 (QR): `/home` → tap event → scan QR (open `/qr` on a third
   device or in another window).
3. Leader 2 (PIN): enter the PIN admin shared.
4. Bad PIN → 5 wrong attempts → lockout.
5. Admin presses Reset PIN → new PIN works.
6. Pause/Resume — leader's check-in is blocked while paused.
7. Manual check-in a defaulted member from `/admin/events/:id/defaulted`.
8. Walk 200m away → next 60s heartbeat checks the leader out.
9. Wait past `ends_at` (or press End) → cron auto-closes everyone.
10. Admin downloads CSV from `/admin/reports`.

## Visual reference

The dark theme + card layouts are the visual template from the original
PVCIO Monitor app (now archived in `src/legacy/`). Theme tokens live in
`src/index.css`.
