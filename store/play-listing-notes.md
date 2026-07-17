# Play Console listing — prepared answers

Assets in this folder: `play-icon-512.png` (app icon), `feature-graphic-1024x500.png`,
`screenshots/` (1200×1920 PNGs straight from a device).

## Store listing copy (suggested)

- **App name:** Hineni — FLC Check-In
- **Short description (≤80 chars):**
  `Geofenced attendance check-in for First Love Church leaders.`
- **Full description (starting point):**
  Hineni records whether First Love Church leaders were physically present at
  church events. Check in with a rotating QR code, a one-time PIN, or Face ID —
  always validated against the venue's GPS geofence and the event's time
  window. Admins get a live dashboard, scope breakdowns, and CSV reports.
  For First Love Church leaders and administrators; an FLC account is required.
- **Category:** Events (or Productivity)
- **Privacy policy URL:** https://hineni.firstlovecenter.com/privacy.html
  (deploys with the app — confirm the contact email in public/privacy.html first)

## Data safety form

"Does your app collect or share user data?" → **Collects: yes. Shares: no.**
All of it: collected (not shared), encrypted in transit, users can request
deletion (via church admins). Not processed ephemerally except where noted.

| Category → Data type | Collected? | Purpose | Notes |
|---|---|---|---|
| Personal info → Name | Yes | App functionality | From FLC directory |
| Personal info → Email address | Yes | App functionality, account management | Login identity |
| Personal info → Phone number | Yes | App functionality | Directory profile |
| Personal info → Other info (church role/unit) | Yes | App functionality | Leadership scope |
| Location → Precise location | Yes | App functionality, fraud prevention | Check-in geofence validation only; no background use |
| Photos and videos | **No** | — | Camera frames processed on-device, never stored/transmitted |
| Health and fitness / Biometrics: declare the face descriptor under "Other data" → describe as optional on-device-derived numeric face template stored in profile; deletable on request | Yes (optional) | App functionality, fraud prevention | Enrolment optional |
| Device or other IDs | Yes | Fraud prevention | Device fingerprint per check-in |
| App activity / interactions | Yes | App functionality | Check-in records, admin audit log |

Also declare under Security practices: data encrypted in transit (HTTPS),
deletion available on request, no data sold.

> Review the biometric row before submitting — Google occasionally reclassifies
> which bucket face templates belong in; describe it honestly and the review
> team will flag if they want it elsewhere.

## Content rating questionnaire (IARC)

Utility/productivity app: answer **No** to every content question (violence,
sexuality, language, controlled substances, gambling, user-generated content,
etc.). Expected rating: Everyone / PEGI 3.

- "Does the app share user's current location with other users?" → **No**
  (location is only checked against the geofence server-side).

## App access (review requirement)

The whole app is behind FLC login, so provide test credentials under
**App content → App access → All or some functionality is restricted**:
add a demo leader account (email + password) that reviewers can use.
Do NOT use a real member's personal account.

## Target audience

18+ (church leaders). Not a children's app.

## Per-release checklist

1. Bump `versionCode` (+1) and `versionName` in `android/app/build.gradle`.
2. `npm run cap:sync`
3. `cd android && ./gradlew bundleRelease`
4. Upload `android/app/build/outputs/bundle/release/app-release.aab`.
