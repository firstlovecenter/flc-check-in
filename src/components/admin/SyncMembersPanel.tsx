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
