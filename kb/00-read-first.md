# Knowledge base — read first

This repo has **two KB layers**:

## 1. Hineni (this app) — start here

**[kb/hineni/README.md](hineni/README.md)** — check-in PWA routes, events, Supabase, design, test accounts.

Agents: **[AGENTS.md](../AGENTS.md)** at repo root.

## 2. FL Admin Portal KB (church structure = Hineni’s source)

| File | Use in Hineni |
|------|----------------|
| [01-glossary.md](01-glossary.md) | ✅ **Required** — same hierarchy & terms |
| [02-user-roles.md](02-user-roles.md) | ✅ **Required** — same role families; Hineni maps them in [hineni/02-auth-and-roles.md](hineni/02-auth-and-roles.md) |
| [hineni/00-church-structure.md](hineni/00-church-structure.md) | ✅ Portal → Hineni derivation |
| [05-data-entities.md](05-data-entities.md) | ✅ Member graph / GraphQL shapes |
| [07-test-accounts.md](07-test-accounts.md) | ✅ Dev logins (+ [hineni/08-test-accounts.md](hineni/08-test-accounts.md)) |
| [03-workflows.md](03-workflows.md) | ❌ Services, arrivals, banking (portal screens only) |
| [04-state-machines.md](04-state-machines.md) | ❌ Portal banking SM (not check-in events) |
| [06-adr.md](06-adr.md) | ⚠️ ADRs; skip portal-only package paths |

Paths like `web-react-ts/kb/` and `api/kb/` refer to the **monorepo elsewhere**, not this checkout.
