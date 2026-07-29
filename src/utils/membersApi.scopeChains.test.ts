// Tests for hierarchy-chain extraction (buildScopeChains / memberToProfileRow).
//
// What this protects against
// --------------------------
// The app used to resolve each hierarchy level independently — leader edge,
// then admin edge, then walk up from the level below — with each level free to
// fall back to a DIFFERENT hierarchy than the level under it. For anyone
// holding edges in two hierarchies that produced a chain which exists nowhere
// in the graph, e.g. Bacenta B → Governorship G1 → Council C2, where G1's real
// parent is C1.
//
// That fabricated chain was written to member_profiles, mirrored into
// localStorage as the user's church context, AND written to the shared
// church_hierarchy table as a parent link — where it corrupted descendant
// scope expansion for every other user of the app.
//
// These tests pin the invariant: a chain never jumps hierarchies.

import { describe, it, expect } from 'vitest'
import { buildScopeChains, memberToProfileRow } from './membersApi'

// ── Fixture hierarchy ───────────────────────────────────────────────────────
// Two distinct chains sharing only the denomination:
//
//   Bacenta B → Governorship G1 → Council C1 → Stream S1 → Campus X → Ov O → D
//                                  Council C2 → Stream S2 → Campus Y → Ov O → D
//
// Kofi LEADS Bacenta B (first chain) and ADMINS Council C2 (second chain).
// The two must never be spliced together.

const denomination = { id: 'd-1', name: 'Denomination' }
const oversight = { id: 'o-1', name: 'Oversight', denomination }

const campusX = { id: 'cam-x', name: 'Campus X', oversight }
const campusY = { id: 'cam-y', name: 'Campus Y', oversight }

const streamS1 = { id: 's-1', name: 'Stream S1', campus: campusX }
const streamS2 = { id: 's-2', name: 'Stream S2', campus: campusY }

const councilC1 = { id: 'c-1', name: 'Council C1', stream: streamS1 }
const councilC2 = { id: 'c-2', name: 'Council C2', stream: streamS2 }

const governorshipG1 = { id: 'g-1', name: 'Governorship G1', council: councilC1 }

const bacentaB = { id: 'b-1', name: 'Bacenta B', governorship: governorshipG1 }

/** Kofi: leads Bacenta B, admins Council C2 — two hierarchies. */
const dualHierarchyMember = {
  id: 'm-kofi',
  firstName: 'Kofi',
  lastName: 'Mensah',
  email: 'kofi@example.com',
  bacenta: { id: 'b-attends', name: 'Bacenta He Attends' },
  leadsBacenta: [bacentaB],
  isAdminForCouncil: [councilC2],
}

describe('buildScopeChains — chains never splice hierarchies', () => {
  it('returns one chain per role edge', () => {
    const chains = buildScopeChains(dualHierarchyMember)
    expect(chains).toHaveLength(2)
  })

  it('keeps the leader chain internally consistent up to denomination', () => {
    const chains = buildScopeChains(dualHierarchyMember)
    const leaderChain = chains.find((c) => c.source === 'leader')!

    expect(leaderChain.level).toBe('bacenta')
    expect(leaderChain.path).toMatchObject({
      bacenta:      { id: 'b-1' },
      governorship: { id: 'g-1' },
      council:      { id: 'c-1' },   // C1, NOT the admin edge's C2
      stream:       { id: 's-1' },
      campus:       { id: 'cam-x' },
      oversight:    { id: 'o-1' },
      denomination: { id: 'd-1' },
    })
  })

  it('keeps the admin chain separate and internally consistent', () => {
    const chains = buildScopeChains(dualHierarchyMember)
    const adminChain = chains.find((c) => c.source === 'admin')!

    expect(adminChain.level).toBe('council')
    expect(adminChain.path).toMatchObject({
      council:      { id: 'c-2' },
      stream:       { id: 's-2' },
      campus:       { id: 'cam-y' },
      oversight:    { id: 'o-1' },
      denomination: { id: 'd-1' },
    })
    // The admin chain starts at council — it must not invent a bacenta.
    expect(adminChain.path.bacenta).toBeUndefined()
  })

  it('orders most-specific-first so [0] is the natural primary identity', () => {
    const chains = buildScopeChains(dualHierarchyMember)
    expect(chains[0].level).toBe('bacenta')
    expect(chains[1].level).toBe('council')
  })

  it('prefers a leader edge over an admin edge at the same level', () => {
    const chains = buildScopeChains({
      id: 'm-2',
      isAdminForCouncil: [councilC2],
      leadsCouncil: [councilC1],
    })
    expect(chains[0].source).toBe('leader')
    expect(chains[0].path.council).toMatchObject({ id: 'c-1' })
  })

  it('is deterministic regardless of the order the graph returns edges in', () => {
    // The graph gives no ordering guarantee. The old pickFirst() meant the
    // stored primary chain could flip between logins and rewrite the row.
    const forward = buildScopeChains({ id: 'm-3', leadsCouncil: [councilC1, councilC2] })
    const reversed = buildScopeChains({ id: 'm-3', leadsCouncil: [councilC2, councilC1] })

    expect(forward.map((c) => c.path[c.level].id))
      .toEqual(reversed.map((c) => c.path[c.level].id))
  })

  it('stops at the first missing parent rather than guessing one', () => {
    // A council with no embedded stream: the chain is short but true.
    const chains = buildScopeChains({
      id: 'm-4',
      leadsCouncil: [{ id: 'c-orphan', name: 'Orphan Council' }],
    })
    expect(chains[0].path).toEqual({ council: { id: 'c-orphan', name: 'Orphan Council' } })
  })

  it('falls back to personal membership only when there are no role edges', () => {
    const chains = buildScopeChains({
      id: 'm-5',
      bacenta: { id: 'b-attends', name: 'Bacenta He Attends' },
    })
    expect(chains).toHaveLength(1)
    expect(chains[0].source).toBe('member')
    expect(chains[0].path.bacenta).toMatchObject({ id: 'b-attends' })
  })

  it('returns nothing for a member with no church relationships at all', () => {
    expect(buildScopeChains({ id: 'm-6' })).toEqual([])
  })
})

describe('memberToProfileRow — flat columns describe ONE real path', () => {
  it('never writes a chain that does not exist in the graph', () => {
    const row = memberToProfileRow(dualHierarchyMember)

    // The regression: council_id used to become C2 (from the admin edge) while
    // governorship_id stayed G1, whose real parent is C1. That path is fiction.
    expect(row.council_id).toBe('c-1')
    expect(row.stream_id).toBe('s-1')
    expect(row.campus_id).toBe('cam-x')

    expect(row.council_id).not.toBe('c-2')
    expect(row.stream_id).not.toBe('s-2')
    expect(row.campus_id).not.toBe('cam-y')
  })

  it('uses the leadership target, not the bacenta the member personally attends', () => {
    const row = memberToProfileRow(dualHierarchyMember)
    expect(row.bacenta_id).toBe('b-1')
    expect(row.bacenta_id).not.toBe('b-attends')
  })

  it('carries every chain in scope_paths so the second hierarchy is not lost', () => {
    const row = memberToProfileRow(dualHierarchyMember)
    expect(row.scope_paths).toHaveLength(2)

    const councils = row.scope_paths.map((c: any) => c.path.council?.id).filter(Boolean)
    expect(councils).toEqual(expect.arrayContaining(['c-1', 'c-2']))
  })

  it('still emits scope_ids as a per-level union for migration-020 consumers', () => {
    const row = memberToProfileRow(dualHierarchyMember)
    expect(row.scope_ids.council).toEqual(expect.arrayContaining(['c-1', 'c-2']))
    expect(row.scope_ids.stream).toEqual(expect.arrayContaining(['s-1', 's-2']))
    // Shared ancestor appears once, not twice.
    expect(row.scope_ids.denomination).toEqual(['d-1'])
  })

  it('keeps the flat columns consistent with one of the scope_paths entries', () => {
    // The invariant the Phase 0 census query checks for in production data.
    const row = memberToProfileRow(dualHierarchyMember)
    const primary = row.scope_paths[0].path

    for (const level of ['bacenta', 'governorship', 'council', 'stream', 'campus', 'oversight', 'denomination']) {
      expect(row[`${level}_id`]).toBe(primary[level]?.id ?? null)
    }
  })
})
