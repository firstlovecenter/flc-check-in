import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  pauseEvent,
  resumeEvent,
  endEvent,
  extendEvent,
  resetPin,
  addAuditLog,
  deleteEvent,
} from '../../utils/supabaseCheckins'
import { generatePin } from '../../utils/checkinsCrypto'
import { getCurrentUser, formatName } from '../../utils/auth'
import { Button } from '../ui/button'
import { Alert } from '../ui/alert'
import { Modal } from '../ui/modal'
import { Input } from '../ui/input'
import { cn } from '../../lib/utils'
import type { CheckinEventRow } from '../../types/app'

interface Props {
  event: CheckinEventRow
  onChange?: (event: CheckinEventRow) => void
}

export default function CheckInAdminControls({ event, onChange }: Props) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const admin = getCurrentUser()
  const adminName = admin ? formatName(admin) : 'Admin'
  // Deleting an event is permitted for its CREATOR and for denomination admins.
  // Authorisation is enforced server-side in delete_event (migration 043); this
  // only decides whether to OFFER the button, so a creator is not shown an
  // action that would be refused, and vice versa.
  const isEventCreator = !!admin && (
    event.created_by_id === admin.userId
    || (!!admin.graphMemberId && event.created_by_id === admin.graphMemberId)
  )
  const canDelete = isEventCreator || !!admin?.isSuperAdmin
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmAction, setConfirmAction] = useState<'end' | 'pin' | 'delete' | null>(null)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [newPinDisplay, setNewPinDisplay] = useState<string | null>(null)

  async function run(
    label: string,
    fn: () => Promise<CheckinEventRow>,
    onSuccess?: (updated: CheckinEventRow) => void,
  ) {
    setBusy(label)
    setActionError(null)
    try {
      const updated = await fn()
      onChange?.(updated)
      onSuccess?.(updated)
    } catch (err: any) {
      setActionError(err.message || t('events.controls.actionFailed'))
    } finally {
      setBusy(null)
    }
  }

  async function handleExtend(minutes: number) {
    const newEnds = new Date(new Date(event.ends_at).getTime() + minutes * 60_000)
    await run(`extend-${minutes}`, () => extendEvent(event.id, newEnds), () => {
      addAuditLog({
        action: 'event.extend',
        actorId: admin?.userId,
        actorName: adminName,
        eventId: event.id,
        details: { minutes },
      }).catch(() => {})
    })
  }

  async function doResetPin() {
    setConfirmAction(null)
    const pin = generatePin()
    setBusy('pin')
    setActionError(null)
    try {
      await resetPin(event.id, pin)
      setNewPinDisplay(pin)
      addAuditLog({
        action: 'pin.reset',
        actorId: admin?.userId,
        actorName: adminName,
        eventId: event.id,
      }).catch(() => {})
    } catch (err: any) {
      setActionError(err.message || t('events.controls.resetFailed'))
    } finally {
      setBusy(null)
    }
  }

  async function doEnd() {
    setConfirmAction(null)
    await run('end', () => endEvent(event.id), (updated) => {
      addAuditLog({
        action: 'event.end',
        actorId: admin?.userId,
        actorName: adminName,
        eventId: event.id,
        details: { status: updated.status },
      }).catch(() => {})
    })
  }

  async function doDelete() {
    setConfirmAction(null)
    setDeleteConfirmText('')
    setBusy('delete')
    setActionError(null)
    try {
      const eventName = event.name
      const eventId = event.id
      await deleteEvent(eventId, admin?.email ?? null, admin?.graphMemberId || admin?.userId || null)
      addAuditLog({
        action: 'event.delete',
        actorId: admin?.userId,
        actorName: adminName,
        eventId,
        details: { event_name: eventName },
      }).catch(() => {})
      navigate('/app/events?view=past', { replace: true })
    } catch (err: any) {
      setActionError(err.message || t('events.controls.deleteFailed'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <div className='flex flex-wrap gap-2'>
        {event.status === 'ACTIVE' && (
          <ControlBtn
            disabled={busy}
            onClick={() =>
              run('pause', () => pauseEvent(event.id), (u) => {
                addAuditLog({
                  action: 'event.pause',
                  actorId: admin?.userId,
                  actorName: adminName,
                  eventId: event.id,
                  details: { status: u.status },
                }).catch(() => {})
              })
            }
          >
            {busy === 'pause' ? '…' : t('events.controls.pause')}
          </ControlBtn>
        )}
        {event.status === 'PAUSED' && (
          <ControlBtn
            disabled={busy}
            onClick={() =>
              run('resume', () => resumeEvent(event.id), (u) => {
                addAuditLog({
                  action: 'event.resume',
                  actorId: admin?.userId,
                  actorName: adminName,
                  eventId: event.id,
                  details: { status: u.status },
                }).catch(() => {})
              })
            }
          >
            {busy === 'resume' ? '…' : t('events.controls.resume')}
          </ControlBtn>
        )}
        {event.status !== 'ENDED' && (
          <>
            <ControlBtn disabled={busy} onClick={() => handleExtend(30)}>
              {t('events.controls.extend30')}
            </ControlBtn>
            <ControlBtn disabled={busy} onClick={() => handleExtend(60)}>
              {t('events.controls.extend60')}
            </ControlBtn>
            {event.allowed_check_in_methods?.includes('PIN') && (
              <ControlBtn
                disabled={busy}
                onClick={() => {
                  setNewPinDisplay(null)
                  setConfirmAction('pin')
                }}
              >
                {busy === 'pin' ? '…' : t('events.controls.resetPin')}
              </ControlBtn>
            )}
            <ControlBtn disabled={busy} danger onClick={() => setConfirmAction('end')}>
              {busy === 'end' ? '…' : t('events.controls.end')}
            </ControlBtn>
          </>
        )}
        {canDelete && (
          <ControlBtn
            disabled={busy}
            danger
            onClick={() => {
              setDeleteConfirmText('')
              setConfirmAction('delete')
            }}
          >
            {busy === 'delete' ? '…' : t('events.controls.delete')}
          </ControlBtn>
        )}
      </div>

      {actionError && (
        <Alert variant='destructive' className='mt-2 text-xs'>
          {actionError}
        </Alert>
      )}

      {newPinDisplay && (
        <Alert variant='info' className='mt-3 flex items-center gap-3'>
          <span className='text-xs text-muted-foreground'>{t('events.controls.newPin')}</span>
          <span className='tnum text-lg font-bold tracking-widest text-primary'>{newPinDisplay}</span>
          <button
            type='button'
            onClick={() => setNewPinDisplay(null)}
            className='icon-btn ml-auto border-0 bg-transparent text-muted-foreground'
            aria-label={t('events.controls.dismiss')}
          >
            ✕
          </button>
        </Alert>
      )}

      <Modal open={!!confirmAction} onClose={() => setConfirmAction(null)} variant='sheet'>
        {confirmAction === 'end' && (
          <>
            <h2 className='m-0 text-base font-semibold text-foreground'>{t('events.controls.endConfirmTitle')}</h2>
            <p className='m-0 mt-1 text-sm text-muted-foreground'>
              {t('events.controls.endConfirmBody')}
            </p>
            <div className='mt-4 flex gap-3'>
              <Button type='button' variant='outline' className='flex-1' onClick={() => setConfirmAction(null)}>
                {t('common.cancel')}
              </Button>
              <Button type='button' variant='destructive' className='flex-1' onClick={doEnd}>
                {t('events.controls.endConfirmBtn')}
              </Button>
            </div>
          </>
        )}
        {confirmAction === 'pin' && (
          <>
            <h2 className='m-0 text-base font-semibold text-foreground'>{t('events.controls.pinConfirmTitle')}</h2>
            <p className='m-0 mt-1 text-sm text-muted-foreground'>
              {t('events.controls.pinConfirmBody')}
            </p>
            <div className='mt-4 flex gap-3'>
              <Button type='button' variant='outline' className='flex-1' onClick={() => setConfirmAction(null)}>
                {t('common.cancel')}
              </Button>
              <Button type='button' className='flex-1' onClick={doResetPin}>
                {t('events.controls.pinConfirmBtn')}
              </Button>
            </div>
          </>
        )}
        {confirmAction === 'delete' && (
          <>
            <h2 className='m-0 text-base font-semibold text-destructive'>{t('events.controls.deleteConfirmTitle')}</h2>
            <p className='m-0 mt-1 text-sm text-muted-foreground'>
              {t('events.controls.deleteConfirmBody')}
            </p>
            <p className='m-0 mt-2 text-xs text-muted-foreground'>
              {t('events.controls.deleteTypePrompt')}
            </p>
            <Input
              type='text'
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder={t('events.controls.deletePlaceholder')}
              autoComplete='off'
              className='my-3'
            />
            <div className='flex gap-3'>
              <Button
                type='button'
                variant='outline'
                className='flex-1'
                onClick={() => {
                  setConfirmAction(null)
                  setDeleteConfirmText('')
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                type='button'
                variant='destructive'
                className='flex-1'
                disabled={deleteConfirmText !== 'DELETE'}
                onClick={doDelete}
              >
                {t('events.controls.deleteConfirmBtn')}
              </Button>
            </div>
          </>
        )}
      </Modal>
    </div>
  )
}

function ControlBtn({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean | string | null
  danger?: boolean
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      disabled={!!disabled}
      className={cn(
        'cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50',
        danger
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-border bg-secondary text-foreground',
      )}
    >
      {children}
    </button>
  )
}
