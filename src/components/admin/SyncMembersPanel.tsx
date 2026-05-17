// Super-admin tool: pull every member under a given scope from the FLC member
// graph and upsert into Supabase `member_profiles`. Lets the admin populate
// profiles ahead of a user's first login or first event creation — without
// this, profiles only get hydrated on those two flows.

import { useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import ScreenHeader from '../ScreenHeader'
import { getCurrentUser } from '../../utils/auth'
import { getMembersInScope, memberToProfileRow } from '../../utils/membersApi'
import { bulkUpsertMemberProfiles } from '../../utils/supabaseCheckins'
import { SCOPE_LEVELS, type ScopeLevel } from '../../types/app'

type SyncState =
  | { status: 'idle' }
  | { status: 'running'; phase: 'fetching' | 'upserting' }
  | { status: 'done'; fetched: number; upserted: number }
  | { status: 'error'; message: string }

interface QuickScope { level: ScopeLevel; id: string; name: string }

// Pull every (level, id) pair the user already has context for — JWT
// churchScopes plus the plain top-level fields enrichUser() leaves on the user
// object. These render as quick-pick chips so a denomination super admin can
// sync their whole tree without typing an ID.
function collectQuickScopes(user): QuickScope[] {
  const out: QuickScope[] = []
  const seen = new Set<string>()
  const push = (level: ScopeLevel, id?: string | null, name?: string | null) => {
    if (!id) return
    const key = `${level}:${id}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ level, id, name: name || level })
  }

  for (const lvl of SCOPE_LEVELS) {
    push(lvl, user?.[lvl]?.id, user?.[lvl]?.name)
  }

  const scopes = user?.churchScopes || {}
  push('denomination', scopes.isAdminForDenominationOf?.id, scopes.isAdminForDenominationOf?.name)
  push('denomination', scopes.leadsDenominationOf?.id,      scopes.leadsDenominationOf?.name)
  push('oversight',    scopes.isAdminForOversightOf?.id,    scopes.isAdminForOversightOf?.name)
  push('oversight',    scopes.leadsOversightOf?.id,         scopes.leadsOversightOf?.name)
  push('campus',       scopes.isAdminForCampusOf?.id,       scopes.isAdminForCampusOf?.name)
  push('campus',       scopes.leadsCampusOf?.id,            scopes.leadsCampusOf?.name)
  push('stream',       scopes.isAdminForStreamOf?.id,       scopes.isAdminForStreamOf?.name)
  push('stream',       scopes.leadsStreamOf?.id,            scopes.leadsStreamOf?.name)
  push('council',      scopes.isAdminForCouncilOf?.id,      scopes.isAdminForCouncilOf?.name)
  push('council',      scopes.leadsCouncilOf?.id,           scopes.leadsCouncilOf?.name)
  push('governorship', scopes.isAdminForGovernorshipOf?.id, scopes.isAdminForGovernorshipOf?.name)
  push('governorship', scopes.leadsGovernorshipOf?.id,      scopes.leadsGovernorshipOf?.name)
  push('bacenta',      scopes.leadsBacentaOf?.id,           scopes.leadsBacentaOf?.name)

  // Denomination first → bacenta last (broadest first is what a super admin wants).
  out.sort((a, b) => SCOPE_LEVELS.indexOf(b.level) - SCOPE_LEVELS.indexOf(a.level))
  return out
}

export default function SyncMembersPanel() {
  const user = getCurrentUser()
  if (!user?.isSuperAdmin) return <Navigate to='/home' replace />

  const quickScopes = useMemo(() => collectQuickScopes(user), [user])
  const [level, setLevel] = useState<ScopeLevel>(quickScopes[0]?.level || 'denomination')
  const [churchId, setChurchId] = useState<string>(quickScopes[0]?.id || '')
  const [state, setState] = useState<SyncState>({ status: 'idle' })

  function selectQuick(scope: QuickScope) {
    setLevel(scope.level)
    setChurchId(scope.id)
    setState({ status: 'idle' })
  }

  async function handleSync() {
    if (!churchId.trim()) {
      setState({ status: 'error', message: 'Church ID is required.' })
      return
    }
    setState({ status: 'running', phase: 'fetching' })
    try {
      const members = await getMembersInScope({ level, churchId: churchId.trim() })
      const rows = members.map(memberToProfileRow)
      setState({ status: 'running', phase: 'upserting' })
      const upserted = await bulkUpsertMemberProfiles(rows)
      setState({ status: 'done', fetched: rows.length, upserted: upserted.length })
    } catch (err: any) {
      setState({ status: 'error', message: err?.message || 'Sync failed' })
    }
  }

  const running = state.status === 'running'

  return (
    <div className='min-h-dvh' style={{ background: 'var(--bg)' }}>
      <ScreenHeader title='Sync Members' />
      <main className='max-w-2xl mx-auto px-4 sm:px-6 py-6 flex flex-col gap-5'>
        <div
          className='p-4'
          style={{
            background: 'var(--card)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-card)',
          }}
        >
          <p className='text-sm m-0 mb-2' style={{ color: 'var(--text)', fontWeight: 600 }}>
            Populate member profiles
          </p>
          <p className='text-xs m-0' style={{ color: 'var(--muted)', lineHeight: 1.5 }}>
            Pulls every leader/admin under the chosen scope from the FLC member
            graph and upserts them into Supabase. Use this when members need to
            appear in dashboards before they log in or are added to an event's
            scope.
          </p>
        </div>

        {quickScopes.length > 0 && (
          <div>
            <p className='eyebrow mb-2'>Your scopes</p>
            <div className='flex flex-wrap gap-2'>
              {quickScopes.map((s) => {
                const selected = s.level === level && s.id === churchId
                return (
                  <button
                    key={`${s.level}:${s.id}`}
                    type='button'
                    onClick={() => selectQuick(s)}
                    disabled={running}
                    className='px-3 py-1.5 text-xs font-semibold cursor-pointer disabled:opacity-50'
                    style={{
                      background: selected ? 'rgba(79,127,255,0.12)' : 'var(--bg2)',
                      color: selected ? 'var(--accent)' : 'var(--text)',
                      border: `1.5px solid ${selected ? 'rgba(79,127,255,0.4)' : 'var(--border)'}`,
                      borderRadius: 'var(--radius-btn)',
                    }}
                  >
                    <span className='uppercase tracking-wider' style={{ fontSize: '0.65rem', opacity: 0.7, marginRight: 6 }}>
                      {s.level}
                    </span>
                    {s.name}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <div className='flex flex-col gap-3'>
          <label className='flex flex-col gap-1.5'>
            <span className='text-xs font-semibold' style={{ color: 'var(--muted)' }}>Scope level</span>
            <select
              value={level}
              onChange={(e) => setLevel(e.target.value as ScopeLevel)}
              disabled={running}
              className='input-field'
              style={{ fontSize: 14, padding: '8px 12px' }}
            >
              {[...SCOPE_LEVELS].reverse().map((lvl) => (
                <option key={lvl} value={lvl}>{lvl}</option>
              ))}
            </select>
          </label>

          <label className='flex flex-col gap-1.5'>
            <span className='text-xs font-semibold' style={{ color: 'var(--muted)' }}>Church ID</span>
            <input
              type='text'
              value={churchId}
              onChange={(e) => setChurchId(e.target.value)}
              disabled={running}
              placeholder='e.g. 5f1e…'
              autoComplete='off'
              autoCorrect='off'
              spellCheck={false}
              className='input-field'
              style={{ fontSize: 14, padding: '8px 12px' }}
            />
          </label>
        </div>

        <button
          type='button'
          onClick={handleSync}
          disabled={running || !churchId.trim()}
          className='px-4 py-2.5 text-sm font-semibold cursor-pointer disabled:opacity-50'
          style={{
            background: 'var(--accent)',
            color: 'var(--bg)',
            border: 'none',
            borderRadius: 'var(--radius-btn)',
          }}
        >
          {running
            ? (state.phase === 'fetching' ? 'Fetching members…' : 'Writing to Supabase…')
            : 'Sync members'}
        </button>

        {state.status === 'done' && (
          <div
            className='p-3 text-sm'
            style={{
              background: 'rgba(34,197,94,0.08)',
              color: 'var(--green, #16a34a)',
              border: '1px solid rgba(34,197,94,0.3)',
              borderRadius: 'var(--radius-btn)',
            }}
          >
            Synced <strong>{state.upserted}</strong> of {state.fetched} member
            {state.fetched === 1 ? '' : 's'} into Supabase.
          </div>
        )}

        {state.status === 'error' && (
          <div
            className='p-3 text-sm'
            style={{
              background: 'rgba(232,96,74,0.08)',
              color: 'var(--coral)',
              border: '1px solid rgba(232,96,74,0.25)',
              borderRadius: 'var(--radius-btn)',
            }}
          >
            {state.message}
          </div>
        )}
      </main>
    </div>
  )
}
