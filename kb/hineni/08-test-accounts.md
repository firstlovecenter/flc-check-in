# Hineni — test accounts

Password for FLC dev auth is typically **`password`** (same as portal — confirm with your team).

Portal roster: [kb/07-test-accounts.md](../07-test-accounts.md). Below are **Hineni-relevant** patterns.

## What Hineni needs at login

1. JWT from FLC auth.
2. Member graph row with at least one `leads*` or `isAdminFor*` edge — or **`superAdmin`** in JWT.

Accounts with only arrivals/teller roles (portal KB) may **fail** `isLeaderOrAdmin` on login.

## Recommended roles for Hineni E2E

| Goal | Portal-style account (from kb/07) |
|------|-----------------------------------|
| Stream admin — create events | `streamadmin@test.com` |
| Council leader — check in | `councilleader@test.com` |
| Bacenta leader — direct check-in | `bacentaleader@test.com` |
| Broad management | `denominationadmin@test.com` or superadmin JWT |

## Superadmin / stream tester

Grant Hineni superadmin in either way:

1. JWT role `superAdmin` from FLC auth (best for **full graph** probe across churches).
2. `INSERT INTO public.superadmins (email) VALUES ('you@example.com');` — Hineni UI bypasses
   scope/role limits; GraphQL visibility still follows that account’s JWT unless it also has
   `superAdmin`.

Superadmins skip `getAdminScopes()` for create-event (church search / special groups instead).
Non–super-admin stream testers still need admin edges or JWT `churchScopes`.

## Public QR page

`/events` — no login. Lists `is_public` active events; superadmin sees more when logged in on other routes.

## E2E checklist (Chrome / e2e-tester agent)

1. Login at `http://localhost:3000/` (dev server **port 3000**).
2. Confirm pink **Sign in** button (design tokens loaded).
3. `/home` — event list or empty state; admin sees **Create Event**.
4. `/admin/events/new` — form sections: Event, Scope, Time, Methods, Geofence.
5. Open live event → dashboard metrics + check-in path.

## Environment blockers

| Symptom | Check |
|---------|-------|
| `Failed to fetch` on home | `VITE_SUPABASE_URL` valid; DNS resolves |
| `notLeader=1` after login | Graph missing leader/admin edges |
| No pink UI | Hard refresh; verify `index.css` loaded; see kb/hineni/07-design-system.md |

## Adding Hineni-only test notes

Append verified emails and scopes here when your team confirms them in dev — do not invent credentials.
