// Super-admin tool: dump every leader/admin from the FLC member graph into
// Supabase `member_profiles`. Lets the admin populate profiles ahead of a
// user's first login or first event creation — without this, profiles only
// get hydrated on those two flows.

import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import ScreenHeader from '../ScreenHeader'
import { PageShell, PageMain } from '../layout/PageShell'
import { Card, CardContent } from '../ui/card'
import { Alert } from '../ui/alert'
import { Button } from '../ui/button'
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
  const [includeAllMembers, setIncludeAllMembers] = useState(false)

  async function handleSync() {
    setState({ status: 'fetching', fetched: 0, kept: 0 })
    try {
      const members = await getAllLeadersAndAdmins((fetched, kept) => {
        setState({ status: 'fetching', fetched, kept })
      }, { includeAllMembers })
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
    <PageShell>
      <ScreenHeader title='Sync Members' />
      <PageMain className='max-w-2xl flex flex-col gap-5'>
        <Card>
          <CardContent className='p-4'>
            <p className='m-0 mb-2 text-sm font-semibold text-foreground'>Populate member profiles</p>
            <p className='m-0 text-xs leading-relaxed text-muted-foreground'>
              Pages the FLC member graph (with your login token) and upserts rows into Supabase.
              Default: leaders and admins only. Optional: every member the graph returns for each page.
              Not limited by your JWT church scopes in this app — graph visibility still depends on
              the FLC API (ideally a JWT with the <code className='text-[11px]'>superAdmin</code> role).
            </p>
          </CardContent>
        </Card>

        <label className='flex items-start gap-2 text-sm text-foreground cursor-pointer'>
          <input
            type='checkbox'
            className='mt-1'
            checked={includeAllMembers}
            onChange={(e) => setIncludeAllMembers(e.target.checked)}
            disabled={running}
          />
          <span>
            Include all members (not only leaders/admins). Larger sync; use for full-directory probes.
          </span>
        </label>

        <Button type='button' onClick={handleSync} disabled={running}>
          {state.status === 'fetching' && `Fetching… (${state.fetched} scanned, ${state.kept} kept)`}
          {state.status === 'upserting' && `Writing ${state.kept} to Supabase…`}
          {!running && 'Sync all members'}
        </Button>

        {state.status === 'done' && (
          <Alert variant='success'>
            Synced <strong>{state.upserted}</strong> leader{state.upserted === 1 ? '' : 's'}/admin
            {state.upserted === 1 ? '' : 's'} into Supabase.
          </Alert>
        )}

        {state.status === 'error' && <Alert variant='destructive'>{state.message}</Alert>}
      </PageMain>
    </PageShell>
  )
}
