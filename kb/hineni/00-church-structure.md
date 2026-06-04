# Hineni — church structure (from FL Admin Portal)

Hineni does **not** define its own church model. Hierarchy, role names, and member relationships
are **the same as the FL Admin Portal** — read from the **same FLC member graph** (GraphQL) and
the **same JWT role strings** issued by the FLC auth service.

## Single source of truth

| Layer | Portal | Hineni |
|-------|--------|--------|
| Hierarchy (Denomination → … → Bacenta) | Neo4j / GraphQL | **Same** — `membersApi.ts` queries portal schema |
| Role strings (`leaderStream`, `adminCouncil`, …) | `global-types` / JWT | **Same** — `AppUser.roles`, `allowed_roles` on events |
| Servant edges (`leads*`, `isAdminFor*`) | GraphQL member fields | **Same** — `isLeaderOrAdmin`, `getAdminScopes`, eligibility |
| Specialist roles (arrivals, teller, …) | Portal screens | Same JWT may include them; Hineni **login gate** usually excludes non-leader/admin |

Canonical definitions: **[kb/01-glossary.md](../01-glossary.md)** and **[kb/02-user-roles.md](../02-user-roles.md)** (role families and tables).

## Hierarchy (identical to portal)

```
Denomination
  └── Oversight
        └── Campus
              └── Stream
                    └── Council
                          └── Governorship
                                └── Bacenta   ← leaf; Hineni README often stops here for leaders
```

Ministry and Fellowship nodes exist on the portal graph; Hineni event scopes use the same
`SCOPE_LEVELS` in `src/types/app.ts` plus **`special_group`** (Hineni-only construct: saved
member lists for cross-cutting events, stored in Supabase — not a separate church tree).

## What Hineni adds (not a different hierarchy)

- **Events** scoped to a graph level + church id, or to a special group.
- **Check-in records** in Supabase (attendance), not portal ServiceRecords.
- **Permission enforcement** in this app: `viewerCaps`, `RequireAdmin`, Supabase RPCs — not
  portal `permitLeader()` / `permitAdmin()` resolvers (see [02-auth-and-roles.md](02-auth-and-roles.md)).

When in doubt about spelling, level order, or what a role means, trust **portal KB + graph**,
then implement using Hineni files under `src/utils/membersApi.ts` and `src/types/app.ts`.
