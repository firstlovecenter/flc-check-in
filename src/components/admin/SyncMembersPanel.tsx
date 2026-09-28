// Super-admin tool: dump every leader/admin from the FLC member graph into
// Supabase `member_profiles`. Lets the admin populate profiles ahead of a
// user's first login or first event creation — without this, profiles only
// get hydrated on those two flows.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate } from 'react-router-dom'
import ScreenHeader from '../ScreenHeader'
import { PageShell, PageMain } from '../layout/PageShell'
import { Card, CardContent } from '../ui/card'
import { Alert } from '../ui/alert'
import { Button } from '../ui/button'
import { getCurrentUser } from '../../utils/auth'
import { getAllLeadersAndAdmins, memberToProfileRow } from '../../utils/membersApi'
import { bulkMarkMemberProfilesInactive, bulkUpsertMemberProfiles } from '../../utils/supabaseCheckins'
import { runTreeSync, type TreeSyncResult } from '../../utils/treeSync'
import { friendlyErrorMessage } from '../../utils/network'

type TreeState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; result: TreeSyncResult }
  | { status: 'error'; message: string }

const TREE_ERROR_KEYS = new Set([
  'denomination_role_required', 'snapshot_too_small', 'invalid_token', 'graph_pull_failed', 'token_required',
])

type SyncState =
  | { status: 'idle' }
  | { status: 'fetching'; fetched: number; kept: number }
  | { status: 'upserting'; kept: number; inactive: number }
  | { status: 'done'; fetched: number; upserted: number; deactivated: number }
  | { status: 'error'; message: string }

export default function SyncMembersPanel() {
  const { t } = useTranslation()
  const user = getCurrentUser()
  if (!user?.isSuperAdmin) return <Navigate to='/home' replace />

  const [state, setState] = useState<SyncState>({ status: 'idle' })
  const [tree, setTree] = useState<TreeState>({ status: 'idle' })

  async function handleTreeSync() {
    setTree({ status: 'running' })
    try {
      const result = await runTreeSync()
      if (result.ok) {
        setTree({ status: 'done', result })
      } else {
        const reason = result.reason ?? ''
        setTree({
          status: 'error',
          message: TREE_ERROR_KEYS.has(reason)
            ? t(`sync.tree.errors.${reason}`)
            : t('sync.tree.errors.generic', { reason: reason || 'unknown' }),
        })
      }
    } catch (err) {
      setTree({ status: 'error', message: friendlyErrorMessage(err) })
    }
  }

  async function handleSync() {
    setState({ status: 'fetching', fetched: 0, kept: 0 })
    try {
      const result = await getAllLeadersAndAdmins((fetched, kept) => {
        setState({ status: 'fetching', fetched, kept })
      })
      setState({ status: 'upserting', kept: result.eligible.length, inactive: result.ineligibleIds.length })
      const rows = result.eligible.map(memberToProfileRow)
      const upserted = await bulkUpsertMemberProfiles(rows)
      const deactivated = await bulkMarkMemberProfilesInactive(result.ineligibleIds)
      setState({ status: 'done', fetched: result.scanned, upserted: upserted.length, deactivated })
    } catch (err: any) {
      setState({ status: 'error', message: err?.message || t('sync.failed') })
    }
  }

  const running = state.status === 'fetching' || state.status === 'upserting'

  return (
    <PageShell>
      <ScreenHeader title={t('sync.title')} />
      <PageMain className='max-w-2xl flex flex-col gap-5'>
        <Card>
          <CardContent className='p-4'>
            <p className='m-0 mb-2 text-sm font-semibold text-foreground'>{t('sync.tree.heading')}</p>
            <p className='m-0 text-xs leading-relaxed text-muted-foreground'>
              {t('sync.tree.description')}
            </p>
          </CardContent>
        </Card>

        <Button type='button' onClick={handleTreeSync} disabled={tree.status === 'running'}>
          {tree.status === 'running' ? t('sync.tree.running') : t('sync.tree.submit')}
        </Button>

        {tree.status === 'done' && (
          <Alert variant='success'>
            {t('sync.tree.done', {
              churches: tree.result.churches ?? 0,
              members: tree.result.members ?? 0,
              edges: tree.result.edges ?? 0,
              ended: tree.result.edges_ended ?? 0,
              removed: tree.result.churches_removed ?? 0,
              orphans: tree.result.orphan_churches ?? 0,
            })}
          </Alert>
        )}
        {tree.status === 'error' && <Alert variant='destructive'>{tree.message}</Alert>}

        <Card>
          <CardContent className='p-4'>
            <p className='m-0 mb-2 text-sm font-semibold text-foreground'>{t('sync.heading')}</p>
            <p className='m-0 text-xs leading-relaxed text-muted-foreground'>
              {t('sync.description')}
            </p>
          </CardContent>
        </Card>

        <Button type='button' onClick={handleSync} disabled={running}>
          {state.status === 'fetching' && t('sync.fetching', { fetched: state.fetched, kept: state.kept })}
          {state.status === 'upserting' && t('sync.upserting', { kept: state.kept, inactive: state.inactive })}
          {!running && t('sync.submit')}
        </Button>

        {state.status === 'done' && (
          <Alert variant='success'>
            {t('sync.done', {
              fetched: state.fetched,
              upserted: state.upserted,
              deactivated: state.deactivated,
              count: state.upserted,
            })}
          </Alert>
        )}

        {state.status === 'error' && <Alert variant='destructive'>{state.message}</Alert>}
      </PageMain>
    </PageShell>
  )
}
