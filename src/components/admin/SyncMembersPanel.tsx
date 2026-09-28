// Super-admin tool: sync the church tree and every leader/deputy/admin
// assignment from the FL Admin Portal, then rebuild member_profiles from it.
//
// Everything runs server-side in the flc-tree-sync edge function (migrations
// 046/047). This replaced a browser-side sync that paged ~23k members through
// the portal from one phone and aborted whenever a single request dropped.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate } from 'react-router-dom'
import ScreenHeader from '../ScreenHeader'
import { PageShell, PageMain } from '../layout/PageShell'
import { Card, CardContent } from '../ui/card'
import { Alert } from '../ui/alert'
import { Button } from '../ui/button'
import { getCurrentUser } from '../../utils/auth'
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

export default function SyncMembersPanel() {
  const { t } = useTranslation()
  const user = getCurrentUser()
  const [tree, setTree] = useState<TreeState>({ status: 'idle' })
  if (!user?.isSuperAdmin) return <Navigate to='/home' replace />

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

  const profiles = tree.status === 'done' ? tree.result.profiles : null

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
            {profiles?.ok && (
              <> {t('sync.tree.profiles', {
                upserted: profiles.upserted ?? 0,
                deactivated: profiles.deactivated ?? 0,
              })}</>
            )}
          </Alert>
        )}
        {tree.status === 'error' && <Alert variant='destructive'>{tree.message}</Alert>}
      </PageMain>
    </PageShell>
  )
}
