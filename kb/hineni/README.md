# Hineni knowledge base

Canonical context for **FLC Check-In** (product name **Hineni**). Agents and humans should read
these files before changing behaviour in this repo.

## Church structure = FL Admin Portal

Hineni’s hierarchy and roles are **derived from the portal** — same graph, same JWT roles, same
`leads*` / `isAdminFor*` edges. Read **[00-church-structure.md](00-church-structure.md)** plus
**[kb/01-glossary.md](../01-glossary.md)** and **[kb/02-user-roles.md](../02-user-roles.md)** for
definitions. Hineni-only docs below cover **check-in UI, events, and Supabase** — not a second
church model.

## Files

| # | File | Use when |
|---|------|----------|
| 00 | [00-church-structure.md](00-church-structure.md) | Portal-derived hierarchy & roles (read early) |
| 01 | [01-overview.md](01-overview.md) | Onboarding, stack, folder map |
| 02 | [02-auth-and-roles.md](02-auth-and-roles.md) | Login, JWT, who can use the app |
| 03 | [03-routes-and-screens.md](03-routes-and-screens.md) | Adding routes or screens |
| 04 | [04-events-and-status.md](04-events-and-status.md) | Events, scopes, dashboard caps |
| 05 | [05-check-in-methods.md](05-check-in-methods.md) | QR/PIN/Face/manual, anti-fraud |
| 06 | [06-data-and-apis.md](06-data-and-apis.md) | Supabase tables, GraphQL, utils |
| 07 | [07-design-system.md](07-design-system.md) | UI, tokens, components |
| 08 | [08-test-accounts.md](08-test-accounts.md) | Manual & E2E test logins |
| 10 | [10-graph-to-supabase.md](10-graph-to-supabase.md) | Graph probe → `member_profiles` / event scoping |

## Relationship to `kb/01`–`07`

| Portal KB | Hineni use |
|-----------|------------|
| [01-glossary.md](../01-glossary.md), [02-user-roles.md](../02-user-roles.md) | **Required** — church structure and role families (same as Hineni) |
| [05-data-entities.md](../05-data-entities.md) | Member graph field shapes when touching GraphQL |
| [07-test-accounts.md](../07-test-accounts.md) | Dev logins (+ [08-test-accounts.md](08-test-accounts.md)) |
| [03-workflows.md](../03-workflows.md), [04-state-machines.md](../04-state-machines.md) | Portal services/banking only — not Hineni check-in flows |

Hineni does **not** ship portal UI (`web-react-ts/`) or `permit*` resolvers; it **does** use the
same underlying church data.

## Entry point for agents

[AGENTS.md](../../AGENTS.md) at the repo root.
