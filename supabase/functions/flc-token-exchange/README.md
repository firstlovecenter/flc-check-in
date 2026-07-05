# flc-token-exchange

Bridges FLC auth-Lambda JWTs to Supabase so Postgres can finally tell users
apart. Until this is enabled, every client talks to the DB as the bare `anon`
role and RLS cannot express "only my scope" rules.

## How it works (introspection — no FLC secret needed)

1. Client logs in against the FLC auth Lambda as usual and holds an FLC JWT.
2. Client POSTs `{ token: <flc jwt> }` here (`src/utils/supabaseTokenExchange.ts`,
   gated by `VITE_USE_SUPABASE_TOKEN_EXCHANGE=1`).
3. This function does **not** check the token's signature itself — it forwards
   the token to the FLC GraphQL API (`FLC_GRAPHQL_URL`), which verifies tokens
   server-side and answers the literal error message "Unauthenticated" for
   forged/expired ones. If the API accepts it, the token is genuine. Only that
   specific message is treated as proof the token is bad (401 `invalid_token`);
   any other GraphQL-level error (schema bug, resolver exception, transient
   hiccup) returns 503 `graph_error` instead, so a real, currently-logged-in
   user isn't forced through the anon-key fallback / dead-ended on "not in
   scope" over something that had nothing to do with their credential.
4. The member's `leads*` / `isAdminFor*` edges from that **live graph response**
   (not the token payload) become the claims, then a Supabase-signed JWT
   (`EXCHANGE_JWT_SECRET` = the project JWT secret) is minted with:
   - `sub` — FLC auth `userId` (the key of `member_profiles.id`)
   - `graph_member_id` — the graph node id (the key used by
     `checkin_records.member_id` / `event_scope_members.member_id`)
   - `email`, `flc_roles` — edge-derived (`leaderBacenta`, `adminCouncil`, …)
   - `flc_scopes` — flattened `{ "<level>:<churchId>": "admin"|"leader" }`
   - `role: "anon"` — **on purpose**; see below.
5. supabase-js attaches the minted token via the `accessToken` option; when
   there is no FLC session (public QR page) — or the exchange fails — it
   transparently falls back to the plain anon key.

Because claims come from the live graph, they are tamper-proof (editing a
token cannot edit graph edges) and immune to the stale-roles-in-JWT problem
the app otherwise fights with `graphProfileSync`.

**Trust anchor:** this design assumes the FLC GraphQL API verifies token
signatures (it rejects unauthenticated requests). That is the same authority
every request in the app already relies on.

## Why the minted token keeps `role: "anon"`

Every existing RLS policy is `to anon using (true)`. Keeping the role
unchanged means flipping the feature flag on is a **zero-behavior-change**
deploy — but `auth.jwt()` claims become visible inside Postgres. Policies can
then be tightened one table at a time, e.g.:

```sql
-- checkin_records: members may only insert their own record.
create policy member_inserts_own on public.checkin_records
  for insert to anon
  with check (member_id = auth.jwt() ->> 'graph_member_id');

-- member_profiles: only the profile owner may update their row.
create policy owner_updates_profile on public.member_profiles
  for update to anon
  using (id = auth.jwt() ->> 'sub');

-- checkin_events: writes require an admin edge covering the event scope.
--   (auth.jwt() -> 'flc_scopes' ->> (scope_level || ':' || scope_church_id)) = 'admin'
--   … plus ancestor checks via get_ancestor_scopes(scope_level, scope_church_id).
```

Requests carrying no JWT claims (plain anon key) simply fail those predicates,
so tightened tables become read/write-able only through the exchange.

## Enablement checklist

1. `supabase secrets set FLC_GRAPHQL_URL=<real FLC GraphQL endpoint> EXCHANGE_JWT_SECRET=<project JWT secret>`
   - `FLC_GRAPHQL_URL` is the URL the frontend proxies to as `/flc-graphql`
     (the `VITE_MEMBER_GRAPHQL_URL` value / Vercel rewrite target).
   - Project JWT secret: Dashboard → Settings → API → JWT Secret.
2. `supabase functions deploy flc-token-exchange`
3. Set `VITE_USE_SUPABASE_TOKEN_EXCHANGE=1` in the frontend env and deploy.
4. Verify: log in, check a PostgREST request in devtools — the `Authorization`
   bearer should be the minted token (issuer `flc-token-exchange`), and app
   behavior should be unchanged.
5. Only then start landing claim-aware policies (one table per migration).

## Notes

- A valid token whose holder has no graph node (e.g. a Supabase-table-only
  superadmin) still exchanges successfully — identity from the payload, empty
  `flc_scopes`. Superadmin powers stay table-driven (`is_super_admin` RPC),
  not claim-driven.
- Exchange cost: one graph round trip per client per token lifetime (~1 h,
  cached in `supabaseTokenExchange.ts`).
- If the FLC signing secret (or an RS256 public key) ever becomes available,
  signature verification can replace the graph call — swap the introspection
  block for `jose.jwtVerify` and drop `FLC_GRAPHQL_URL`.
