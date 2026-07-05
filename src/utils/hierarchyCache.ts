// Opportunistic Postgres cache of the FLC church tree (church_hierarchy).
//
// The graph (Neo4j via GraphQL) stays the source of truth. Whenever the app
// walks the graph anyway — ancestor chains, child lists — the shape it learned
// is mirrored into Supabase, fire-and-forget. Once a subtree is fully mirrored
// (every non-leaf node has children_synced_at set), get_descendant_scopes can
// answer scope expansions in one round trip and the per-level GraphQL BFS is
// skipped entirely (see supabaseCheckins.getDescendantScopeKeysForScope).
//
// This module must not import membersApi or supabaseCheckins (both import it).

import { supabase } from './supabase'
import { SCOPE_LEVELS, type ScopeLevel } from '../types/app'

export interface HierarchyNode {
  level: string
  id: string
  name?: string | null
}

// Session-level dedup so hot paths (eligibility loads, home feed) don't
// re-upsert the same rows over and over. Cleared on reload — that's fine,
// one upsert per node per session is the intended write rate.
const _syncedChains = new Set<string>()
const _syncedChildren = new Set<string>()

function isChurchLevel(level: string | undefined | null): boolean {
  return !!level && level !== 'special_group' && (SCOPE_LEVELS as readonly string[]).includes(level)
}

/** The direct parent level of a church level, or null for denomination.
 *  SCOPE_LEVELS is ordered lowest → highest (bacenta → denomination). */
function parentLevelOf(level: string): string | null {
  const idx = SCOPE_LEVELS.indexOf(level as ScopeLevel)
  if (idx < 0 || idx >= SCOPE_LEVELS.length - 1) return null
  const parent = SCOPE_LEVELS[idx + 1]
  return parent === 'special_group' ? null : parent
}

/** Mirror an ancestor chain (highest level first, e.g. from
 *  getChurchAncestors or a member_profiles row) into church_hierarchy.
 *
 *  Parent links are only written between levels that are DIRECTLY adjacent
 *  in the hierarchy — a chain with a gap (e.g. council → bacenta with no
 *  governorship) stores both nodes but no link across the gap, because a
 *  wrong parent_id would corrupt descendant expansion. Fire-and-forget. */
export function cacheHierarchyChain(chain: HierarchyNode[] | null | undefined): void {
  const nodes = (chain || []).filter((n) => n?.id && isChurchLevel(n.level))
  if (nodes.length === 0) return

  const rows: any[] = []
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    const key = `${node.level}:${node.id}`
    if (_syncedChains.has(key)) continue
    _syncedChains.add(key)
    const prev = i > 0 ? nodes[i - 1] : null
    const linked = prev && parentLevelOf(node.level) === prev.level
    rows.push({
      id: node.id,
      level: node.level,
      name: node.name || null,
      parent_id: linked ? prev!.id : null,
      parent_level: linked ? prev!.level : null,
      updated_at: new Date().toISOString(),
    })
  }
  if (rows.length === 0) return

  // Rows WITH a parent link may overwrite (they carry strictly more info);
  // rows without one must not clobber a previously-stored parent, so they
  // insert-only (ignoreDuplicates → ON CONFLICT DO NOTHING).
  const linked = rows.filter((r) => r.parent_id)
  const unlinked = rows.filter((r) => !r.parent_id)
  const retryKeys = () => rows.forEach((r) => _syncedChains.delete(`${r.level}:${r.id}`))

  if (linked.length) {
    Promise.resolve(
      supabase.from('church_hierarchy').upsert(linked, { onConflict: 'id' }),
    ).then(({ error }) => { if (error) retryKeys() }).catch(retryKeys)
  }
  if (unlinked.length) {
    Promise.resolve(
      supabase.from('church_hierarchy').upsert(unlinked, { onConflict: 'id', ignoreDuplicates: true }),
    ).then(({ error }) => { if (error) retryKeys() }).catch(retryKeys)
  }
}

/** Mirror a COMPLETE child list of a parent scope into church_hierarchy and
 *  stamp the parent's children_synced_at marker. Only call with the full
 *  child set (as returned by getChildChurches) — the marker is a promise to
 *  get_descendant_scopes that no child of this parent is missing. */
export function cacheHierarchyChildren(
  parent: { level: string; id: string; name?: string | null },
  childLevel: string | null | undefined,
  children: Array<{ id: string; name?: string | null }> | null | undefined,
): void {
  if (!parent?.id || !isChurchLevel(parent.level)) return
  if (!isChurchLevel(childLevel ?? undefined) && (children || []).length > 0) return
  const parentKey = `${parent.level}:${parent.id}`
  if (_syncedChildren.has(parentKey)) return
  _syncedChildren.add(parentKey)
  const retry = () => _syncedChildren.delete(parentKey)

  const now = new Date().toISOString()
  const childRows = (children || [])
    .filter((c) => c?.id)
    .map((c) => ({
      id: c.id,
      level: childLevel,
      name: c.name || null,
      parent_id: parent.id,
      parent_level: parent.level,
      updated_at: now,
    }))

  const run = async () => {
    if (childRows.length) {
      const { error } = await supabase
        .from('church_hierarchy')
        .upsert(childRows, { onConflict: 'id' })
      if (error) throw error
    }
    // Parent marker: upsert only the marker columns so an existing row's
    // name/parent link is left alone.
    const { error } = await supabase
      .from('church_hierarchy')
      .upsert(
        { id: parent.id, level: parent.level, children_synced_at: now, updated_at: now },
        { onConflict: 'id' },
      )
    if (error) throw error
  }
  run().catch(retry)
}

/** Descendant scope set for one scope from Postgres, or null when the cache
 *  cannot prove completeness (missing root / unsynced non-leaf) — callers
 *  must then fall back to the GraphQL BFS. */
export async function fetchDescendantScopesFromDb(
  scope: { level: string; id: string },
): Promise<Array<{ level: string; id: string }> | null> {
  if (!isChurchLevel(scope?.level) || !scope?.id) return null
  const { data, error } = await supabase.rpc('get_descendant_scopes', {
    p_level: scope.level,
    p_id: scope.id,
  })
  if (error || !data?.length) return null
  return data.map((r: any) => ({ level: r.level, id: r.id }))
}

/** Ancestor chain (highest first) from Postgres, or null when nothing cached.
 *  Partial chains are returned as-is — useful as a graph-outage fallback. */
export async function fetchAncestorScopesFromDb(
  scope: { level: string; id: string },
): Promise<Array<{ level: string; id: string; name: string | null }> | null> {
  if (!isChurchLevel(scope?.level) || !scope?.id) return null
  const { data, error } = await supabase.rpc('get_ancestor_scopes', {
    p_level: scope.level,
    p_id: scope.id,
  })
  if (error || !data?.length) return null
  return data.map((r: any) => ({ level: r.level, id: r.id, name: r.name ?? null }))
}
