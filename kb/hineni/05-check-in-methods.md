# Hineni — check-in methods

Allowed methods per event: `allowed_check_in_methods` — subset of `QR` | `PIN` | `FACE_ID` | `MANUAL`.

Server validation lives in Supabase RPCs (`submit_checkin`, etc.); client checks are UX only
except crypto generation.

## QR

- Display: `QRDisplayScreen`, event dashboard, `QRCodeDisplay` + `checkinsCrypto.ts` (HMAC, 60s buckets).
- Scan: `CheckInFormScreen` → `QRScanner` / `@zxing/browser`.
- Accepts current + previous time bucket at boundary.

## PIN

- HOTP-style 6-digit, 15s window from event `qr_secret_hex`.
- Rate limit: 5 failures / 10 min → 15 min lockout (server).
- Admin can reset PIN from dashboard controls.

## Face ID

- Enrol: `FaceEnrollSweep` / `FaceCapture` — 5 frames → mean 128-d descriptor in `member_profiles`.
- Match: distance &lt; 0.55 + blink liveness; `claim_face_match` then `submit_checkin`.
- Claim TTL 60s, single use. Admin reset via Member Biometrics.

## Manual (admin)

- `FullReport` defaulted tab — admin on-site, reason required, audit logged.
- Same geofence rules as leaders.

## Anti-fraud (summary)

| Defence | Mechanism |
|---------|-----------|
| Remote check-in | Geofence in RPC |
| Device sharing | `claim_device_for_event` + risky banner |
| Clock skew | Postgres `now()` |
| Walk-away | Location heartbeat + auto-checkout edge function |

Details: [README.md](../../README.md) anti-fraud table.

## UI surfaces

- `GeofenceGuard` / `GeofencePicker` — Leaflet circle or polygon.
- `PullToRefreshIndicator` + `RefreshButton` — global refresh signal for lists/dashboard.
