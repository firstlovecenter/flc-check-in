# FLC Check-In

Geofenced, time-windowed leader check-in for First Love Church. React + Vite +
Tailwind frontend, Supabase backend, FLC member GraphQL for identity and
hierarchy.

A leader at a venue can check in via **QR scan, PIN, or Face ID**. An admin can
also manually check anyone in. Every path is anchored to the event's geofence
and time window — there is no way to check in remotely.

## Stack

| Layer | Tech |
|---|---|
| UI | React 19 + Vite 8 + Tailwind 4 + React Router 7 (TypeScript) |
| Auth | FLC Lambda (JWT, proxied via Vite dev server / Vercel serverless function) |
| Member directory | FLC GraphQL — `graphql-request`, same-origin via `/flc-graphql` proxy |
| Data | Supabase Postgres (RLS off; atomicity via security-definer RPCs) |
| Auto-checkout | Supabase Edge Function on a 1-minute cron schedule |
| Map | Leaflet + OpenStreetMap (no API key) |
| QR | `qrcode` (display) + `@zxing/browser` (scan) |
| PIN | `bcryptjs` (browser) + `pgcrypto` (server) — 5 attempts / 10 min → 15 min lockout |
| Face ID | `face-api.js` (browser-only — no biometric data ever leaves the device except a 128-float descriptor) |
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

Optional (only if deploying the auto-checkout Edge Function from this machine):
```
SUPABASE_ACCESS_TOKEN=sbp_<your-personal-access-token>
```

### Same-origin proxies

The browser never talks directly to the FLC auth Lambda or GraphQL endpoint —
that would trigger CORS errors. Instead:

- **Dev** — Vite proxies `/api/flc-auth/*` and `/flc-graphql` to the upstream
  origins (see `vite.config.js`).
- **Prod (Vercel)** — `api/flc-auth/[...path].js` is a serverless function that
  forwards requests; `vercel.json` rewrites `/flc-graphql` and serves
  `index.html` for unknown paths (SPA fallback).

## Supabase setup

1. Create a new Supabase project; paste URL + publishable key into `.env`.
2. **SQL editor** → paste `supabase/checkins_schema.sql` → Run. This creates
   the 5 tables, all RPCs, helper functions, and disables RLS.
3. Apply migrations in `supabase/migrations/` in order. The most recent is
   `20260512_face_id_checkin.sql` which adds the Face ID surface.
4. Verify end-to-end:
   ```bash
   node supabase/smoke_test.mjs
   ```
   Should print 17 ✓ checks and "smoke test PASSED".
5. Deploy the auto-checkout Edge Function — see
   `supabase/functions/auto-checkout/README.md`.

## App structure

```
src/
  App.tsx                      Routes (public, protected via RequireAuth, admin-only)
  main.tsx
  index.css                    Theme tokens — --bg, --card, --accent, …
  types/app.ts                 AppUser, CheckinEventRow, CheckinRecordRow, …
  screens/
    LoginScreen.tsx            Email/password → JWT; gates non-leaders
    ForgotPasswordScreen.tsx
    ResetPasswordScreen.tsx
    LeaderHomeScreen.tsx       Active + recent events at my GPS
    QRDisplayScreen.tsx        Public-facing QR display at the venue
    CheckInFormScreen.tsx      Per-event form — QR / PIN / Face ID tabs
    ProfileScreen.tsx          FLC graph member profile + church hierarchy
    admin/
      CreateEventScreen.tsx
      EventDashboardScreen.tsx
      EventEditScreen.tsx
      FullReportScreen.tsx     Tabbed: checked-in, defaulted, checked-out
      ScopeBreakdownScreen.tsx
      ReportsScreen.tsx        CSV export
      EventHistoryScreen.tsx   Union of events you admin + ones you attended
  components/
    TopBar.tsx                 Home screen header — greeting + level badge
    ScreenHeader.tsx           Generic header with hamburger + title + back link
    NavDrawer.tsx              Slide-in nav, theme toggle, profile, sign-out
    RequireAuth.tsx            Route guard — sends signed-out users to /
    checkin/
      EventCardForLeader.tsx
      GeofenceGuard.tsx        Acquires GPS, blocks render if outside fence
      QRScanner.tsx            @zxing/browser camera reader
      QRCodeDisplay.tsx        qrcode → canvas
      PinEntry.tsx             6-digit input with rate-limit feedback
      FaceCapture.tsx          face-api.js camera component (enroll + verify)
      LocationHeartbeat.tsx    60s reportLocation tick while checked in
    admin/
      RequireAdmin.tsx         Route guard
      CreateEventForm.tsx      Multi-section form (uses GeoFencePicker)
      GeoFencePicker.tsx       Leaflet map — circle or polygon modes
      EventDashboard.tsx       Live stats + QR + admin controls
      CheckInAdminControls.tsx Pause / Resume / Extend / Reset PIN / End
      FullReport.tsx           Tabbed lists with drilldown
      ManualCheckInModal.tsx
      ScopeBreakdown.tsx
      ReportsList.tsx          CSV export via papaparse
      EventHistoryList.tsx
    fields/                    Reusable form fields
  utils/
    auth.ts                    JWT decode, role→level, login, post-login sync
    supabase.ts                Supabase client
    supabaseCheckins.ts        Every check-in DB call routes through here
    membersApi.ts              FLC GraphQL adapter (leaders/admins only)
    membersApi.queries.ts      GraphQL query strings
    faceApi.ts                 face-api.js model loader + descriptor helpers
    geo.ts                     Haversine, polygon, GPS wrappers
    checkinsCrypto.ts          PIN/QR helpers (bcryptjs + WebCrypto HMAC)
    deviceFingerprint.ts       FingerprintJS singleton
api/
  flc-auth/[...path].js        Vercel serverless proxy → auth Lambda (CORS workaround)
public/
  models/                      face-api.js weights (~6.8MB, loaded lazily)
  flc-logo-circle.jpeg         App logo (login + reset screens)
  icon-192x192.png             PWA / favicon
  icon-512x512.png             PWA / favicon
supabase/
  checkins_schema.sql          Apply once in Supabase SQL editor
  checkins_schema_fix_001.sql  First-run patch (RLS off + pgcrypto schema)
  smoke_test.mjs               Phase-1 RPC smoke test
  migrations/                  Incremental schema changes — apply in order
  functions/
    auto-checkout/             Edge Function for time-based auto-checkout
```

## Hierarchy + roles

The 7 FLC scope levels, lowest to highest:
`bacenta → governorship → council → stream → campus → oversight → denomination`

The app's universe is members with at least one `leads*` or `isAdminFor*`
relationship in the FLC member graph — regular members without leadership
relationships are blocked at login.

Admins (`adminStream`, `adminCouncil`, etc.) can create events at their level
and any level below it — `getAdminScopes(member)` aggregates every
`leads*` / `isAdminFor*` edge a member holds.

## Check-in methods

All four paths share the same submission RPC (`submit_checkin`) and produce a
`checkin_records` row with `method = 'QR' | 'PIN' | 'MANUAL' | 'FACE_ID'`.

### QR
Rotating HMAC-SHA256 token. Server accepts the current and previous 60-second
bucket so a scan mid-rotation isn't rejected. The QR display screen
(`/events`) refreshes every 30 seconds and is accessible without sign-in so
it can run on a stationary device at the venue.

### PIN
6-digit PIN, bcrypt-hashed server-side. `record_pin_attempt` RPC enforces
rate-limit (5 wrong attempts in 10 minutes → 15-minute lockout) atomically.
Admins can reset the PIN from `CheckInAdminControls`.

### Face ID
Browser-only matching via `face-api.js`:
1. On first use the user enrolls — the component captures 3 stable frames
   and averages their 128-float descriptors. The descriptor (no image) is
   stored in `member_profiles.face_descriptor`.
2. On subsequent check-ins the component runs detection at ~5fps, compares
   each frame's descriptor against the stored one (Euclidean distance <
   0.55) and requires a complete blink (eyes open → closed → open via eye
   aspect ratio) as a liveness check.
3. On match + blink, the client calls `claim_face_match(event, member)` to
   record a server-side claim, then calls `submit_checkin` with method
   `FACE_ID`. The RPC requires a fresh claim (<60s) and consumes it.

No raw images or video are stored or transmitted — only the 128-float
descriptor. Models (~6.8MB) live in `public/models/` and are loaded lazily
on first FACE_ID tab open.

### Manual (admin)
Admins can manually check in a member from the defaulted list. Same
geofence check; admin's device fingerprint is recorded as `manual:<adminId>`
and the row's `verified_by` field is populated.

## Anti-fraud

- **Geofence** — every check-in path validates client-side (instant feedback)
  and server-side (`point_in_event_geofence` RPC). Cannot be bypassed.
- **Rotating QR** — HMAC-SHA256 with 60-second time bucket; current and
  previous bucket accepted.
- **PIN rate-limit** — 5 wrong attempts in 10 min → 15-min lockout; enforced
  atomically in `record_pin_attempt`.
- **Face liveness** — blink required during verification (EAR drops below 0.20
  then recovers above 0.27); single-face only, multi-face frames rejected.
- **Face claim TTL** — server requires a `face_match_claims` row <60s old and
  deletes it on success, so a leaked claim can't be reused.
- **Device fingerprint** — one fingerprint per member per event, claimed
  atomically via `claim_device_for_event`.
- **Location heartbeat** — checked-in leaders' devices send GPS every 60s;
  walking outside the geofence triggers an auto-checkout.
- **Manual check-in by admin** — geofence-enforced; admin must be on-site,
  supplies a written reason.

## Routes

| Path | Access | Notes |
|---|---|---|
| `/` | Public | Login |
| `/forgot-password` | Public | Email reset link |
| `/reset-password?token=…` | Public | Reset via emailed token |
| `/events` | Public | QR display screen for venue device |
| `/home` | Auth | Leader home — active + past events |
| `/checkin/:eventId` | Auth | Per-event check-in (QR / PIN / Face ID) |
| `/events/:eventId` | Auth | Event dashboard (adapts to viewer role) |
| `/events/:eventId/edit` | Admin | Edit event |
| `/events/:eventId/report` | Auth | Full report — tabbed |
| `/events/:eventId/scopes` | Auth | Scope breakdown |
| `/admin/events/new` | Admin | Create event |
| `/admin/reports` | Admin | CSV export |
| `/admin/history` | Auth | Event history — events you attended + ones you admin |
| `/profile` | Auth | FLC graph member profile |

## Build / deploy

```bash
npm run build       # writes dist/
npm run preview     # local preview of the production build
npm run lint
npm run typecheck
```

Vercel picks up `vercel.json` for routing and `api/flc-auth/` for the
serverless proxy. Set the same `VITE_*` env vars in the Vercel project
settings as in your local `.env`.

## Test plan

End-to-end smoke (one admin device + two leader devices, all at same location):

1. Admin → `/admin/events/new` → create event (scope = your bacenta, ends in
   1h, methods QR + PIN + FACE_ID, circle 50m geofence around current GPS).
2. **QR** — Leader 1 → `/home` → tap event → scan QR (open `/qr` on a third
   device or another tab).
3. **PIN** — Leader 2 → enter the PIN admin shared.
4. **Face ID** — Leader 3 → first run prompts enrollment (3-frame capture) →
   subsequent runs verify with blink.
5. **PIN rate-limit** — 5 wrong attempts → lockout. Admin presses Reset PIN
   → new PIN works.
6. **Pause / Resume** — leader's check-in is blocked while paused.
7. **Manual** — admin checks in a defaulted member from
   `/events/:id/report?tab=defaulted`.
8. **Heartbeat** — walk 200m away → next 60s heartbeat checks the leader out.
9. **Auto-close** — wait past `ends_at` (or press End) → cron auto-closes
   everyone still checked in.
10. **Reports** — admin downloads CSV from `/admin/reports`.

## Status

- v1 ✅ — QR + PIN + Manual + Face ID (with blink liveness)
- v1.1 (planned) — re-enrollment UI, admin face audit/reset, deeper
  anti-spoofing (texture / depth)
