// Verify the GraphQL queries against the live FLC endpoint.
// Run: node scripts/test_members_api.mjs
//
// Tests the query strings (not the adapter, since it depends on Vite's
// import.meta.env shim). The adapter is just a thin wrapper around these
// queries.

import { GraphQLClient } from 'graphql-request'
import {
  GET_MEMBERS_FOR_BACENTA,
  GET_MEMBERS_FOR_STREAM,
  GET_MEMBER_BY_ID,
} from '../src/utils/membersApi.queries.js'

const URL = 'https://dev-api-synago.firstlovecenter.com/graphql'
const c = new GraphQLClient(URL)

function step(label, ok, extra = '') {
  console.log(`${ok ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) process.exitCode = 1
}

// Local copy of the helpers we want to assert on (same logic as
// src/utils/membersApi.js, kept here so we don't have to import that file
// and trip on import.meta.env).
const isLeaderOrAdmin = (m) => [
  m.leadsBacenta, m.leadsGovernorship, m.leadsCouncil,
  m.leadsStream, m.leadsCampus, m.leadsOversight, m.leadsDenomination,
  m.isAdminForGovernorship, m.isAdminForCouncil, m.isAdminForStream,
  m.isAdminForCampus, m.isAdminForOversight, m.isAdminForDenomination,
].some((arr) => Array.isArray(arr) && arr.length > 0)

;(async () => {
  // ─── 1. Find a bacenta that has at least one leader (loop a few) ──────
  // Some test bacentas have no leader. Walk a small batch to find one with a
  // populated leadsBacenta inverse.
  const { bacentas } = await c.request('{bacentas(limit:50){id name}}')
  let bacentaId = null
  let bacentaName = null
  for (const b of bacentas || []) {
    const r = await c.request(GET_MEMBERS_FOR_BACENTA, { churchId: b.id })
    if ((r.members || []).length > 0) {
      bacentaId = b.id; bacentaName = b.name; break
    }
  }
  step('found a bacenta with at least one leader', !!bacentaId,
       bacentaId ? `id=${bacentaId} name="${bacentaName}"` : 'tried 50 bacentas, none had a leader')
  if (!bacentaId) return

  // ─── 2. GET_MEMBERS_FOR_BACENTA ────────────────────────────────────────
  const { members: bacentaMembers } = await c.request(GET_MEMBERS_FOR_BACENTA, { churchId: bacentaId })
  step('GET_MEMBERS_FOR_BACENTA returned an array', Array.isArray(bacentaMembers),
       `count=${bacentaMembers?.length ?? 0}`)

  if (bacentaMembers?.length) {
    // ─── 3. Every returned member is a leader/admin ──────────────────────
    const allLeaders = bacentaMembers.every(isLeaderOrAdmin)
    step('every returned member is a leader/admin (OR-filter works)', allLeaders)

    // ─── 4. The bacenta leader is in the list ────────────────────────────
    const leaderInList = bacentaMembers.some((m) =>
      m.leadsBacenta?.some((b) => b.id === bacentaId)
    )
    step('the bacenta leader is in the list', leaderInList)

    // ─── 5. GET_MEMBER_BY_ID round-trip ───────────────────────────────────
    const sampleId = bacentaMembers[0].id
    const r = await c.request(GET_MEMBER_BY_ID, { id: sampleId })
    step('GET_MEMBER_BY_ID round-trips the same member',
         r.members?.[0]?.id === sampleId)
  }

  // ─── 6. Pick a real stream and test the deep-nested query ─────────────
  const { streams } = await c.request('{streams(limit:1){id name}}')
  const streamId = streams?.[0]?.id
  if (streamId) {
    const t0 = Date.now()
    const { members: streamMembers } = await c.request(GET_MEMBERS_FOR_STREAM, { churchId: streamId })
    step(`GET_MEMBERS_FOR_STREAM (deep nesting) returned in ${Date.now() - t0}ms`,
         Array.isArray(streamMembers),
         `count=${streamMembers?.length ?? 0}`)
    if (streamMembers?.length) {
      const allLeaders = streamMembers.every(isLeaderOrAdmin)
      step('stream-scope members are all leaders/admins', allLeaders)
    }
  }

  console.log(process.exitCode ? '\n✗ FAILED' : '\n✓ PASSED')
})().catch((e) => { console.error('CRASH:', e.message); process.exit(1) })
