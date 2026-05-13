# FLC Check-In

> Attendance tracking for First Love Church leaders — geofenced, time-windowed,
> and fraud-resistant.

---

## What is this?

FLC Check-In is a mobile-first web app that records whether church leaders
physically showed up to an event. It is not a general-purpose attendance
register — it is built specifically for **First Love Church's leadership
structure** (Bacenta → Governorship → Council → Stream).

### For a first-time reader

Imagine your church runs a weekly gathering and the district leadership wants to
know which leaders actually attended — not just who clicked a form online. This
app solves that by combining three safeguards:

1. **You must be physically present.** Every check-in validates that your phone
   is inside a GPS fence drawn around the venue. There is no way to check in
   from home.
2. **The window is time-locked.** Check-in opens one hour before the event
   starts and closes when the event ends. The server enforces this — changing
   your phone's clock achieves nothing.
3. **Your identity is verified.** You prove who you are via a rotating QR code,
   a one-time PIN, or facial recognition (with a liveness blink test).

Admins see a live dashboard while the event is running, can pause or extend it,
and download full CSV reports afterwards. Every admin action is written to an
immutable audit log.

---

## Stack

| Layer | Technology |
|---|---|
| UI | React 19 + Vite 6 + Tailwind 4 + React Router 7 (TypeScript) |
| Auth | FLC Lambda (JWT), proxied via Vite dev server / Vercel serverless |
| Member directory | FLC GraphQL — `graphql-request`, same-origin proxy |
| Database | Supabase Postgres — RLS on; atomicity via security-definer RPCs |
| Realtime | Supabase Realtime (`postgres_changes` on `checkin_records`) |
| Auto-checkout | Supabase Edge Function on a 1-minute cron schedule |
| Map | Leaflet + OpenStreetMap (no API key required) |
| QR | `qrcode` (display) + `@zxing/browser` (scan) |
| PIN | HOTP-style 6-digit OTP — HMAC-SHA256 over 15-second buckets |
| Face ID | `face-api.js` — browser-only matching; only a 128-float descriptor is stored |
| Device fingerprint | `@fingerprintjs/fingerprintjs` — one device per member per event |
| CSV export | `papaparse` |

---

## Church hierarchy

```
Stream  (e.g. Colossians)
  └── Council / Oversight
        └── Governorship
              └── Bacenta   ← smallest unit; a leader leads one
```

The app's universe is FLC members who hold at least one leadership or admin
relationship in the FLC member graph. Regular members without a leadership role
are blocked at login.

Admins (`adminStream`, `adminCouncil`, etc.) can create and manage events at
their own scope and any scope below it.

---

## How a check-in works — step by step

```
Leader opens the app on their phone at the venue
           │
           ▼
     Logs in with FLC credentials
     (JWT issued by FLC auth Lambda)
           │
           ▼
     Home screen — lists active events near their GPS location
           │
           ▼
     Taps an event card
           │
     ┌─────┴────────────────────────────┐
     │  GeofenceGuard acquires GPS       │
     │  if outside fence → blocked       │
     └─────┬────────────────────────────┘
           │  inside fence
           ▼
     CheckInFormScreen — three tabs:
     ┌──────────┬────────┬──────────┐
     │  QR Scan │  PIN   │  Face ID │
     └────┬─────┴───┬────┴─────┬────┘
          │         │          │
          ▼         ▼          ▼
     (see below)  (see below) (see below)
           │
           ▼  on success
     "Checked in ✓" screen
     Location heartbeat starts (60s GPS ping)
           │
           ▼  walks away / event ends
     Auto-checkout by server
```

### QR scan
A stationary screen at the venue shows a rotating QR code (refreshes every
30 s). The QR encodes an HMAC-SHA256 token bound to the event ID and a 60-second
time bucket. The server accepts the current and previous bucket so a scan right
at the rotation boundary is not rejected.

### PIN
A 6-digit one-time PIN is generated from the event's secret key and the current
15-second time window (HOTP). The admin shares this number verbally. Wrong
attempts are counted: 5 wrong tries in 10 minutes triggers a 15-minute lockout,
enforced server-side. Admins can reset the PIN at any time.

### Face ID
1. **Enrolment (first time only):** The camera captures 5 stable frames. Their
   128-float descriptors are averaged and stored in `member_profiles.face_descriptor`.
   No image or video is ever stored or transmitted. The quality of the five
   descriptors is scored (good / fair / poor) based on their pairwise Euclidean
   distance.
2. **Verification:** At ~5 fps the camera compares each frame's descriptor
   against the stored one. A match requires distance < 0.55 **plus** a liveness
   blink (eye aspect ratio drops below 0.20 then recovers above 0.27). Multi-face
   frames are rejected.
3. On match, the client calls `claim_face_match` to register a server-side claim,
   then immediately calls `submit_checkin`. The server requires a fresh claim
   (< 60 s) and deletes it on success, so a leaked claim cannot be reused.

### Manual (admin only)
An admin can check in a member from the **Defaulted** tab of the event report.
The same geofence applies — the admin must be on-site — and a written reason is
required. Every manual check-in is written to the audit log.

---

## Admin capabilities

Admins access a richer set of screens:

| Screen | What it does |
|---|---|
| **Create Event** | Multi-section form: name, scope, time window, allowed methods, geofence (circle or polygon on a Leaflet map), grace period |
| **Event Dashboard** | Live occupancy counter (Supabase Realtime), QR display, admin controls, risk warning banner if any device is shared across multiple members |
| **Admin Controls** | Pause, Resume, Extend (add minutes), Reset PIN, End event — all actions logged in the audit trail |
| **Full Report** | Three tabs — Checked In, Defaulted (absent), Checked Out. Defaulted tab supports recording an absence reason. Risky check-ins (device shared across members) show a ⚠ badge. |
| **Scope Breakdown** | Attendance counts broken down by Bacenta / Governorship / Council |
| **CSV Reports** | Download full event data as a CSV |
| **Event History** | Every event you administered or attended, with check-in status |
| **Audit Log** | Immutable, append-only trail of every admin action for an event |
| **Member Biometrics** | View or clear a member's stored face descriptor |

---

## Anti-fraud measures

| Threat | Defence |
|---|---|
| Remote check-in | Geofence validated server-side in every RPC; client-side check is a UX hint only |
| Stale QR token | HMAC-SHA256 with 60-second buckets; only current + previous bucket accepted |
| Shared PIN | 15-second HOTP window; rate-limit: 5 wrong attempts → 15-min lockout |
| Face photo spoofing | Blink liveness test (EAR threshold); single-face-only enforcement |
| Replayed face claim | Claim TTL 60 s; consumed on first use |
| Device sharing | `claim_device_for_event` atomically reserves a fingerprint per member; duplicate → `device_already_used`; dashboard shows a warning banner if any fingerprint appears for more than one member |
| Clock manipulation | Server (`now()` in Postgres) is the sole time authority |
| Walking away after check-in | 60-second location heartbeat; leaving the geofence triggers auto-checkout |
| Indefinite events | Admin can end early; cron auto-closes everyone still checked in when `ends_at` passes |

---

## Database schema

All tables live in the `public` schema with RLS enabled.

| Table | Purpose |
|---|---|
| `member_profiles` | Cached FLC member info + `face_descriptor` (128 floats as JSON) |
| `checkin_events` | One row per event — scope, time window, geofence, `qr_secret`, status |
| `checkin_records` | One row per successful check-in — method, GPS, device, `is_late` |
| `event_scope_members` | Expected attendees for an event (denormalised from FLC graph at creation) |
| `checkin_attempts` | Every PIN attempt (for rate-limiting) — written only via `record_pin_attempt` RPC |
| `checkin_devices` | Fingerprint reservations per event — written only via `claim_device_for_event` RPC |
| `face_match_claims` | Short-lived face-match claims; consumed by `submit_checkin` |
| `absence_notes` | Admin-recorded reasons for member absences (composite PK: event + member) |
| `audit_log` | Append-only admin action trail (event/checkin/face/pin/absence actions) |

Security-definer RPCs (`submit_checkin`, `record_pin_attempt`, `claim_device_for_event`,
`claim_face_match`) run as `postgres` and bypass RLS. The `anon` role can never
directly write to the rate-limit or device tables.

### Key RPCs

| RPC | What it does |
|---|---|
| `submit_checkin` | Full pipeline: status → time window → method auth → geofence → device claim → insert record |
| `create_checkin_event` | Atomic event creation — scope members are denormalised in the same transaction |
| `record_pin_attempt` | Validates HOTP and enforces rate-limit atomically |
| `claim_face_match` | Inserts a short-lived face claim row |
| `claim_device_for_event` | Reserves a fingerprint for one member per event |
| `report_member_location` | Heartbeat — updates location and auto-checks out if outside fence |
| `auto_checkout_expired_events` | Called by cron; closes all active events past `ends_at` |
| `reset_event_pin` | Admin resets the OTP secret for an event |

---

## Local development

### Prerequisites

- Node 20+
- A Supabase project (free tier is fine)
- FLC auth Lambda URL (ask the FLC tech team)

### Setup

```bash
git clone https://github.com/firstlovecenter/flc-pvcio-monitor.git
cd flc-pvcio-monitor
npm install
```

Create `.env` in the project root:

```
VITE_AUTH_API_URL=https://<lambda-url>.lambda-url.eu-west-2.on.aws/auth
VITE_MEMBER_GRAPHQL_URL=https://dev-api-synago.firstlovecenter.com/graphql
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_<...>
```

```bash
npm run dev   # http://localhost:3000
```

### Database setup

1. Open your Supabase project → SQL editor.
2. Paste the contents of `supabase/init.sql` and run it.  
   This is the **single source of truth** for the full schema: all tables,
   RPCs, helpers, RLS policies, and grants. Safe to re-run (all statements
   use `IF NOT EXISTS` / `CREATE OR REPLACE`).
3. Verify everything works:
   ```bash
   node supabase/smoke_test.mjs
   ```
   Should print 17 ✓ checks and `smoke test PASSED`.
4. Deploy the auto-checkout Edge Function:
   ```bash
   supabase functions deploy auto-checkout
   ```
   See `supabase/functions/auto-checkout/README.md` for the cron schedule setup.

### Same-origin proxies

The browser never talks directly to the FLC auth Lambda or GraphQL endpoint —
that would trigger CORS errors.

- **Dev** — Vite proxies `/api/flc-auth/*` and `/flc-graphql` to the upstream
  origins (configured in `vite.config.js`).
- **Prod (Vercel)** — `api/flc-auth/[...path].js` is a serverless function that
  forwards requests; `vercel.json` rewrites `/flc-graphql` and serves
  `index.html` for all unknown paths (SPA fallback).

---

## Project structure

```
src/
  App.tsx                      Routes (public / RequireAuth / RequireAdmin)
  main.tsx
  index.css                    CSS custom properties — --bg, --card, --accent, …
  types/app.ts                 AppUser, CheckinEventRow, CheckinRecordRow, …

  screens/
    LoginScreen.tsx            Email + password → JWT; blocks non-leaders
    ForgotPasswordScreen.tsx
    ResetPasswordScreen.tsx
    LeaderHomeScreen.tsx       Active + recent events near your GPS location
    QRDisplayScreen.tsx        Public QR display (no login needed, run on a
                               stationary screen at the venue)
    CheckInFormScreen.tsx      Per-event check-in — QR / PIN / Face ID tabs
    ProfileScreen.tsx          FLC member graph profile + hierarchy + stats
    admin/
      CreateEventScreen.tsx
      EventDashboardScreen.tsx
      EventEditScreen.tsx
      FullReportScreen.tsx     Tabbed: Checked-In | Defaulted | Checked-Out
      ScopeBreakdownScreen.tsx
      ReportsScreen.tsx        CSV export
      EventHistoryScreen.tsx
      AuditLogScreen.tsx       Per-event admin action trail

  components/
    TopBar.tsx                 Home header — greeting + level badge
    ScreenHeader.tsx           Generic screen header with back link + hamburger
    NavDrawer.tsx              Slide-in nav — profile, theme toggle, sign-out
    RequireAuth.tsx            Route guard — redirects to / if signed out
    SplashScreen.tsx           Loading state while models / auth initialise
    BiometricEnrolGate.tsx     Prompts Face ID enrolment if descriptor absent

    checkin/
      EventCardForLeader.tsx   Card shown on the home screen for each event
      GeofenceGuard.tsx        Acquires GPS; blocks render if outside fence
      QRCodeDisplay.tsx        qrcode → canvas, refreshed every 30 s
      QRScanner.tsx            @zxing/browser camera reader
      PinEntry.tsx             6-digit input with rate-limit feedback
      FaceCapture.tsx          face-api.js camera — enrol or verify
      FaceEnrollSweep.tsx      5-frame enrolment with quality badge (good/fair/poor)
      LocationHeartbeat.tsx    60-second GPS heartbeat while checked in

    admin/
      RequireAdmin.tsx         Route guard for admin-only screens
      CreateEventForm.tsx      Multi-section form (uses GeoFencePicker)
      GeoFencePicker.tsx       Leaflet map — circle or polygon geofence modes
      EventDashboard.tsx       Live stats, QR panel, admin controls, risk banner
      CheckInAdminControls.tsx Pause / Resume / Extend / Reset PIN / End
      FullReport.tsx           Tabbed lists + absence notes + risky-device badges
      ManualCheckInModal.tsx   Manual check-in with reason
      ScopeBreakdown.tsx       Attendance by unit
      ReportsList.tsx          CSV export via papaparse
      EventHistoryList.tsx
      MemberBiometrics.tsx     View / clear face descriptor
      AuditLog.tsx             Audit trail component

    fields/                    Reusable form field components

  utils/
    auth.ts              JWT decode, role→level mapping, login, post-login sync
    supabase.ts          Supabase client (singleton)
    supabaseCheckins.ts  Every DB call for check-in features
    membersApi.ts        FLC GraphQL adapter
    membersApi.queries.ts GraphQL query strings
    faceApi.ts           face-api.js model loader + descriptor helpers
    geo.ts               Haversine distance, polygon inclusion, GPS wrappers
    checkinsCrypto.ts    QR/PIN token generation and verification (WebCrypto)
    deviceFingerprint.ts FingerprintJS singleton

api/
  flc-auth/[...path].js  Vercel serverless proxy → FLC auth Lambda

public/
  models/               face-api.js weights (~6.8 MB, loaded lazily)

supabase/
  init.sql              Full schema — run once in Supabase SQL editor
  smoke_test.mjs        End-to-end RPC smoke test
  migrations/           Numbered migration files (for reference / incremental upgrades)
    005_absence_notes.sql
    006_audit_log.sql
    007_early_checkin_window.sql
  functions/
    auto-checkout/      Supabase Edge Function — 1-minute cron
```

---

## Routes

| Path | Access | Screen |
|---|---|---|
| `/` | Public | Login |
| `/forgot-password` | Public | Forgot password |
| `/reset-password?token=…` | Public | Password reset |
| `/events` | Public | QR display (venue screen, no login) |
| `/home` | Auth | Leader home — active + past events |
| `/checkin/:eventId` | Auth | Check-in form (QR / PIN / Face ID) |
| `/events/:eventId` | Auth | Event dashboard (adapts to viewer role) |
| `/events/:eventId/edit` | Admin | Edit event |
| `/events/:eventId/report` | Auth | Full report (tabbed) |
| `/events/:eventId/scopes` | Auth | Scope breakdown |
| `/events/:eventId/audit` | Admin | Audit log |
| `/admin/events/new` | Admin | Create event |
| `/admin/reports` | Admin | CSV export |
| `/admin/history` | Auth | Event history |
| `/profile` | Auth | FLC member profile + attendance stats |

---

## Build & deploy

```bash
npm run build       # outputs dist/
npm run preview     # local preview of the production build
npm run lint
npm run typecheck   # npx tsc --noEmit
```

Deploy target is **Vercel**. Set the same `VITE_*` environment variables in
the Vercel project settings as in your local `.env`. The `vercel.json` file
handles SPA routing and the `/flc-graphql` proxy rewrite automatically.

---

## End-to-end test plan

Requires one admin device and two or more leader devices, all physically at
the same location.

1. **Create event** — Admin → `/admin/events/new`. Set scope to your Bacenta,
   end time +1 h, methods QR + PIN + FACE_ID, draw a 50 m circle geofence
   around your current GPS.
2. **QR check-in** — Leader 1 → `/home` → tap event → QR tab → scan the code
   shown on a nearby screen or a second browser tab at `/events`.
3. **PIN check-in** — Leader 2 → PIN tab → enter the 6-digit OTP from the
   admin's dashboard.
4. **Face ID check-in** — Leader 3 → Face ID tab → first run triggers enrolment
   (5-frame capture, quality badge shown). On subsequent runs: look at camera,
   blink once → checked in.
5. **PIN rate-limit** — Enter 5 wrong PINs → observe lockout message. Admin
   presses **Reset PIN** → new OTP works immediately.
6. **Pause / Resume** — Admin pauses event; leader attempt is blocked with
   "event paused". Admin resumes; check-in succeeds.
7. **Manual check-in** — Admin → Full Report → Defaulted tab → tap a member →
   Manual Check-In → enter reason → confirm.
8. **Location heartbeat** — After check-in, move 200 m outside the geofence.
   Within ~60 s the heartbeat triggers an auto-checkout.
9. **Auto-close** — Wait past `ends_at` (or press **End**). The cron job closes
   all still-checked-in records automatically.
10. **Absence reason** — Admin → Full Report → Defaulted tab → tap a defaulted
    member → enter absence reason → save. Reason persists in `absence_notes`.
11. **Audit log** — Admin → Event Dashboard → "Audit Log" link. Verify that
    Pause, Resume, Manual Check-In, PIN Reset, and End actions all appear with
    timestamps and actor names.
12. **Reports** — Admin → `/admin/reports` → download CSV. Open in a
    spreadsheet and verify all check-in records are present.

---

## Environment variables reference

| Variable | Required | Description |
|---|---|---|
| `VITE_AUTH_API_URL` | Yes | FLC auth Lambda base URL |
| `VITE_MEMBER_GRAPHQL_URL` | Yes | FLC member GraphQL endpoint |
| `VITE_SUPABASE_URL` | Yes | Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Yes | Supabase anon/publishable key |
| `SUPABASE_ACCESS_TOKEN` | Deploy only | Personal access token for `supabase functions deploy` |

---

## Roadmap

| Status | Item |
|---|---|
| ✅ v1 | QR + PIN + Manual + Face ID with blink liveness |
| ✅ v1.1 | Realtime dashboard, absence notes, audit log, device-sharing risk flags, early check-in window (1 h), face enrolment quality score |
| ⏳ Next | Bulk manual check-in from the Defaulted tab |
| 🔮 Future | Re-enrolment UI, admin face audit/reset, deeper anti-spoofing (texture / depth), push notifications |

