// Super-admin tool: dump every leader/admin from the FLC member graph into
// Supabase `member_profiles`. Lets the admin populate profiles ahead of a
// user's first login or first event creation — without this, profiles only
// get hydrated on those two flows.

import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import ScreenHeader from '../ScreenHeader'
import { getCurrentUser } from '../../utils/auth'
import { getAllLeadersAndAdmins, memberToProfileRow } from '../../utils/membersApi'
import { bulkUpsertMemberProfiles } from '../../utils/supabaseCheckins'

type SyncState =
  | { status: 'idle' }
  | { status: 'fetching'; fetched: number; kept: number }
  | { status: 'upserting'; kept: number }
  | { status: 'done'; fetched: number; upserted: number }
  | { status: 'error'; message: string }

export default function SyncMembersPanel() {
  const user = getCurrentUser()
  if (!user?.isSuperAdmin) return <Navigate to='/home' replace />

  const [state, setState] = useState<SyncState>({ status: 'idle' })

  async function handleSync() {
    setState({ status: 'fetching', fetched: 0, kept: 0 })
    try {
      const members = await getAllLeadersAndAdmins((fetched, kept) => {
        setState({ status: 'fetching', fetched, kept })
      })
      setState({ status: 'upserting', kept: members.length })
      const rows = members.map(memberToProfileRow)
      const upserted = await bulkUpsertMemberProfiles(rows)
      setState({ status: 'done', fetched: rows.length, upserted: upserted.length })
    } catch (err: any) {
      setState({ status: 'error', message: err?.message || 'Sync failed' })
    }
  }

  const running = state.status === 'fetching' || state.status === 'upserting'

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
            Pulls every leader and admin from the FLC member graph and upserts
            them into Supabase. Use this to make members appear in dashboards
            before they log in or get added to an event's scope.
          </p>
        </div>

        <button
          type='button'
          onClick={handleSync}
          disabled={running}
          className='px-4 py-2.5 text-sm font-semibold cursor-pointer disabled:opacity-50'
          style={{
            background: 'var(--accent)',
            color: 'var(--bg)',
            border: 'none',
            borderRadius: 'var(--radius-btn)',
          }}
        >
          {state.status === 'fetching' && `Fetching… (${state.fetched} scanned, ${state.kept} kept)`}
          {state.status === 'upserting' && `Writing ${state.kept} to Supabase…`}
          {!running && 'Sync all members'}
        </button>

        {state.status === 'done' && (
          <div
            className='p-3 text-sm'
            style={{
              background: 'color-mix(in oklab, var(--present) 8%, transparent)',
              color: 'var(--green, #16a34a)',
              border: '1px solid color-mix(in oklab, var(--present) 30%, transparent)',
              borderRadius: 'var(--radius-btn)',
            }}
          >
            Synced <strong>{state.upserted}</strong> leader{state.upserted === 1 ? '' : 's'}/admin{state.upserted === 1 ? '' : 's'} into Supabase.
          </div>
        )}

        {state.status === 'error' && (
          <div
            className='p-3 text-sm'
            style={{
              background: 'color-mix(in oklab, var(--absent) 8%, transparent)',
              color: 'var(--coral)',
              border: '1px solid color-mix(in oklab, var(--absent) 25%, transparent)',
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
