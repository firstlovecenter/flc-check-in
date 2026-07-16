import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
  const navigate = useNavigate()
  const admin = getCurrentUser()
  const adminName = admin ? formatName(admin) : 'Admin'
  const isSuperAdmin = !!admin?.isSuperAdmin
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
      setActionError(err.message || 'Action failed')
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
      setActionError(err.message || 'Reset failed')
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
      await deleteEvent(eventId, admin?.email || '')
      addAuditLog({
        action: 'event.delete',
        actorId: admin?.userId,
        actorName: adminName,
        eventId,
        details: { event_name: eventName },
      }).catch(() => {})
      navigate('/app/events?view=past', { replace: true })
    } catch (err: any) {
      setActionError(err.message || 'Delete failed')
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
            {busy === 'pause' ? '…' : 'Pause'}
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
            {busy === 'resume' ? '…' : 'Resume'}
          </ControlBtn>
        )}
        {event.status !== 'ENDED' && (
          <>
            <ControlBtn disabled={busy} onClick={() => handleExtend(30)}>
              +30 min
            </ControlBtn>
            <ControlBtn disabled={busy} onClick={() => handleExtend(60)}>
              +60 min
            </ControlBtn>
            {event.allowed_check_in_methods?.includes('PIN') && (
              <ControlBtn
                disabled={busy}
                onClick={() => {
                  setNewPinDisplay(null)
                  setConfirmAction('pin')
                }}
              >
                {busy === 'pin' ? '…' : 'Reset PIN'}
              </ControlBtn>
            )}
            <ControlBtn disabled={busy} danger onClick={() => setConfirmAction('end')}>
              {busy === 'end' ? '…' : 'End'}
            </ControlBtn>
          </>
        )}
        {isSuperAdmin && (
          <ControlBtn
            disabled={busy}
            danger
            onClick={() => {
              setDeleteConfirmText('')
              setConfirmAction('delete')
            }}
          >
            {busy === 'delete' ? '…' : '🗑 Delete'}
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
          <span className='text-xs text-muted-foreground'>New PIN:</span>
          <span className='tnum text-lg font-bold tracking-widest text-primary'>{newPinDisplay}</span>
          <button
            type='button'
            onClick={() => setNewPinDisplay(null)}
            className='icon-btn ml-auto border-0 bg-transparent text-muted-foreground'
            aria-label='Dismiss'
          >
            ✕
          </button>
        </Alert>
      )}

      <Modal open={!!confirmAction} onClose={() => setConfirmAction(null)} variant='sheet'>
        {confirmAction === 'end' && (
          <>
            <h2 className='m-0 text-base font-semibold text-foreground'>End this event?</h2>
            <p className='m-0 mt-1 text-sm text-muted-foreground'>
              All open check-ins will be closed. This cannot be undone.
            </p>
            <div className='mt-4 flex gap-3'>
              <Button type='button' variant='outline' className='flex-1' onClick={() => setConfirmAction(null)}>
                Cancel
              </Button>
              <Button type='button' variant='destructive' className='flex-1' onClick={doEnd}>
                End Event
              </Button>
            </div>
          </>
        )}
        {confirmAction === 'pin' && (
          <>
            <h2 className='m-0 text-base font-semibold text-foreground'>Reset PIN?</h2>
            <p className='m-0 mt-1 text-sm text-muted-foreground'>
              A new PIN will be generated. The old one stops working immediately.
            </p>
            <div className='mt-4 flex gap-3'>
              <Button type='button' variant='outline' className='flex-1' onClick={() => setConfirmAction(null)}>
                Cancel
              </Button>
              <Button type='button' className='flex-1' onClick={doResetPin}>
                Generate New PIN
              </Button>
            </div>
          </>
        )}
        {confirmAction === 'delete' && (
          <>
            <h2 className='m-0 text-base font-semibold text-destructive'>Permanently delete this event?</h2>
            <p className='m-0 mt-1 text-sm text-muted-foreground'>
              This removes the event, every check-in record, and all related data.{' '}
              <strong className='text-destructive'>This cannot be undone.</strong>
            </p>
            <p className='m-0 mt-2 text-xs text-muted-foreground'>
              Type <code className='font-bold text-destructive'>DELETE</code> to confirm:
            </p>
            <Input
              type='text'
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder='DELETE'
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
                Cancel
              </Button>
              <Button
                type='button'
                variant='destructive'
                className='flex-1'
                disabled={deleteConfirmText !== 'DELETE'}
                onClick={doDelete}
              >
                Delete forever
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
