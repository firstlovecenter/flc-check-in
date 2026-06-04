# Agent guide — FLC Hineni (flc-check-in)

This repository is **Hineni**, the mobile-first **FLC Check-In** PWA — not the FL Admin Portal
(`web-react-ts/` / `api/`). Always use **Hineni context** when implementing, reviewing, or testing here.

## Read first (Hineni)

| Doc | Contents |
|-----|----------|
| [kb/hineni/README.md](kb/hineni/README.md) | Index of all Hineni KB files |
| [kb/hineni/00-church-structure.md](kb/hineni/00-church-structure.md) | **Same hierarchy as portal** (graph + JWT) |
| [kb/hineni/01-overview.md](kb/hineni/01-overview.md) | Product, stack, repo layout |
| [kb/hineni/02-auth-and-roles.md](kb/hineni/02-auth-and-roles.md) | JWT, login gate, admin vs leader, superadmin |
| [kb/hineni/03-routes-and-screens.md](kb/hineni/03-routes-and-screens.md) | React Router map, guards |
| [kb/hineni/04-events-and-status.md](kb/hineni/04-events-and-status.md) | Event lifecycle, scopes, viewer capabilities |
| [kb/hineni/05-check-in-methods.md](kb/hineni/05-check-in-methods.md) | QR, PIN, Face ID, manual, fraud |
| [kb/hineni/06-data-and-apis.md](kb/hineni/06-data-and-apis.md) | Supabase, GraphQL member API, key files |
| [kb/hineni/07-design-system.md](kb/hineni/07-design-system.md) | Tokens, UI kit, DESIGN-new mapping |
| [kb/hineni/08-test-accounts.md](kb/hineni/08-test-accounts.md) | Dev logins for Hineni E2E |

## Church structure & roles (same as FL Admin Portal)

Hineni **derives** hierarchy and roles from the portal — same GraphQL member graph, same JWT role
strings (`leaderBacenta`, `adminStream`, …). Read:

- [kb/01-glossary.md](kb/01-glossary.md) — canonical terms and hierarchy
- [kb/02-user-roles.md](kb/02-user-roles.md) — role families (leader / admin / specialist tables)
- [kb/hineni/00-church-structure.md](kb/hineni/00-church-structure.md) — how portal maps to Hineni code

Hineni does **not** reimplement `permit*` from `permission-utils.ts`; it uses `viewerCaps`,
`getAdminScopes`, and Supabase instead — **same people and scopes**, different enforcement layer.

## Portal KB — workflows only (not Hineni product flows)

- [kb/05-data-entities.md](kb/05-data-entities.md) — member graph shapes when editing GraphQL queries
- [kb/03-workflows.md](kb/03-workflows.md), [kb/04-state-machines.md](kb/04-state-machines.md) —
  services, arrivals, banking (portal only)

## Design

- Spec: [DESIGN-new.md](DESIGN-new.md)
- Hineni implementation: [DESIGN.md](DESIGN.md) + [kb/hineni/07-design-system.md](kb/hineni/07-design-system.md)
- Tokens: `src/design-tokens.css`, `src/index.css`

## Commands (quality)

```bash
npm run dev          # port 3000 (strict)
npm run typecheck
npm run build
npm test
```

When editing `src/**/*.ts(x)`, run `npm run typecheck` before finishing.

## Do not assume

- No `web-react-ts/`, `api/`, Apollo `AppShell`, or `permitLeader()` in this repo.
- Authorization is **client UX + Supabase RPCs**; server enforces geofence, time, PIN, face claims.
- `RequireAdmin` only checks `user.isAdmin` (JWT-derived), not portal permission-utils.
