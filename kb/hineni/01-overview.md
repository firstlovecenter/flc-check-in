# Hineni — overview

**Hineni** (`flc-check-in`) is a mobile-first PWA for **First Love Church leaders** to check in
to time-windowed, geofenced events. Admins create events and monitor attendance; leaders check
in on-site via QR, PIN, or Face ID.

Full product narrative: [README.md](../../README.md).

## Church structure

**Same as FL Admin Portal** — Denomination → Oversight → Campus → Stream → Council →
Governorship → Bacenta, plus Ministry where applicable on the graph. Hineni reads this via the
shared FLC GraphQL API (`membersApi.ts`), not a local copy of the tree. Details:
[00-church-structure.md](00-church-structure.md), [kb/01-glossary.md](../01-glossary.md).

## Stack (this repo)

| Layer | Path / tech |
|-------|-------------|
| UI | React 19, Vite, TypeScript, Tailwind 4, React Router 7 |
| Auth | FLC JWT via `/api/flc-auth` proxy → `src/utils/auth.ts` |
| Member directory | FLC GraphQL via `/flc-graphql` → `src/utils/membersApi.ts` |
| Data | Supabase Postgres + Realtime → `src/utils/supabaseCheckins.ts` |
| Design | `DESIGN-new.md`, `src/design-tokens.css`, `src/index.css`, `src/components/ui/` |

## Repo layout (high signal)

```
src/
  App.tsx                 # Routes
  screens/                # Route screens (Login, LeaderHome, CheckIn, admin/*)
  components/
    admin/                # EventDashboard, CreateEventForm, FullReport, …
    ui/                   # shadcn-style primitives (Button, Card, …)
    layout/               # PageShell, AuthLayout
    NavDrawer.tsx         # Mobile nav (not portal AppShell)
  hooks/                  # useTheme, useEventEligibility, useRefreshSignal
  utils/                  # auth, membersApi, supabaseCheckins, checkinsCrypto
  types/app.ts            # AppUser, CheckinEventRow, SCOPE_LEVELS
  design-tokens.css
  index.css
kb/hineni/                # ← Hineni-specific agent KB (this folder)
```

## What Hineni is not

- Not the Synago / FL Admin Portal (`web-react-ts`, `api`, Apollo, Formik).
- Not a general member attendance app — login requires **leader or admin** on the FL graph.
- Not offline-first — check-in needs network for Supabase RPCs.

## Naming

Use **Hineni** in user-facing copy where the app brand appears; repo/package name is `flc-check-in`.
