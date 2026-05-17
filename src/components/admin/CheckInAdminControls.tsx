import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  pauseEvent, resumeEvent, endEvent, extendEvent, resetPin, addAuditLog,
  deleteEvent,
} from '../../utils/supabaseCheckins'
import { generatePin } from '../../utils/checkinsCrypto'
import { getCurrentUser, formatName } from '../../utils/auth'
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
  const [busy, setBusy]         = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // Inline confirmation — stores the pending action id ('end' | 'pin' | 'delete').
  const [confirmAction, setConfirmAction] = useState<'end' | 'pin' | 'delete' | null>(null)
  // Type-to-confirm string for the destructive delete action.
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  // The newly generated PIN to display inline instead of alert().
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
      addAuditLog({ action: 'event.extend', actorId: admin?.userId, actorName: adminName, eventId: event.id, details: { minutes } }).catch(() => {})
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
      addAuditLog({ action: 'pin.reset', actorId: admin?.userId, actorName: adminName, eventId: event.id }).catch(() => {})
    } catch (err: any) {
      setActionError(err.message || 'Reset failed')
    } finally {
      setBusy(null)
    }
  }

  async function doEnd() {
    setConfirmAction(null)
    await run('end', () => endEvent(event.id), (updated) => {
      addAuditLog({ action: 'event.end', actorId: admin?.userId, actorName: adminName, eventId: event.id, details: { status: updated.status } }).catch(() => {})
    })
  }

  async function doDelete() {
    setConfirmAction(null)
    setDeleteConfirmText('')
    setBusy('delete')
    setActionError(null)
    try {
      // Capture event identity BEFORE delete for the audit log entry —
      // event_id on audit_log is `on delete set null`, so we lose the
      // direct link, but the details payload still names the event.
      const eventName = event.name
      const eventId = event.id
      await deleteEvent(eventId, admin?.email || '')
      // Best-effort audit log — eventId will be set to null by the FK cascade,
      // but the row is preserved with the details payload for traceability.
      addAuditLog({
        action: 'event.delete',
        actorId: admin?.userId,
        actorName: adminName,
        eventId,
        details: { event_name: eventName },
      }).catch(() => {})
      // Navigate away — the event no longer exists.
      navigate('/admin/history', { replace: true })
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
          <Btn disabled={busy} onClick={() => run('pause', () => pauseEvent(event.id), (u) => {
            addAuditLog({ action: 'event.pause', actorId: admin?.userId, actorName: adminName, eventId: event.id, details: { status: u.status } }).catch(() => {})
          })}>
            {busy === 'pause' ? '…' : 'Pause'}
          </Btn>
        )}
        {event.status === 'PAUSED' && (
          <Btn disabled={busy} onClick={() => run('resume', () => resumeEvent(event.id), (u) => {
            addAuditLog({ action: 'event.resume', actorId: admin?.userId, actorName: adminName, eventId: event.id, details: { status: u.status } }).catch(() => {})
          })}>
            {busy === 'resume' ? '…' : 'Resume'}
          </Btn>
        )}
        {event.status !== 'ENDED' && (
          <>
            <Btn disabled={busy} onClick={() => handleExtend(30)}>+30 min</Btn>
            <Btn disabled={busy} onClick={() => handleExtend(60)}>+60 min</Btn>
            {event.allowed_check_in_methods?.includes('PIN') && (
              <Btn disabled={busy} onClick={() => { setNewPinDisplay(null); setConfirmAction('pin') }}>
                {busy === 'pin' ? '…' : 'Reset PIN'}
              </Btn>
            )}
            <Btn disabled={busy} danger onClick={() => setConfirmAction('end')}>
              {busy === 'end' ? '…' : 'End'}
            </Btn>
          </>
        )}
        {/* Super-admin only: hard-delete the event (any status). Server
            re-checks isSuperAdmin via the superadmins table — this is just
            the UI gate. */}
        {isSuperAdmin && (
          <Btn disabled={busy} danger onClick={() => { setDeleteConfirmText(''); setConfirmAction('delete') }}>
            {busy === 'delete' ? '…' : '🗑 Delete'}
          </Btn>
        )}
      </div>

      {/* Inline error */}
      {actionError && (
        <p style={{ color: 'var(--coral)', fontSize: '0.8rem', marginTop: '0.5rem' }}>
          {actionError}
        </p>
      )}

      {/* New PIN display (replaces alert) */}
      {newPinDisplay && (
        <div
          style={{
            marginTop: '0.75rem', padding: '0.75rem 1rem',
            background: 'rgba(79,127,255,0.08)', border: '1px solid rgba(79,127,255,0.3)',
            borderRadius: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem',
          }}
        >
          <span style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>New PIN:</span>
          <span style={{ color: 'var(--accent)', fontWeight: 700, letterSpacing: '0.15em', fontSize: '1.1rem' }}>
            {newPinDisplay}
          </span>
          <button
            onClick={() => setNewPinDisplay(null)}
            style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '1rem' }}
            aria-label='Dismiss'
          >✕</button>
        </div>
      )}

      {/* Inline confirmation sheet (replaces window.confirm — broken on iOS PWA) */}
      {confirmAction && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)',
            display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
            zIndex: 999, padding: '1rem',
          }}
          onClick={() => setConfirmAction(null)}
        >
          <div
            style={{
              background: 'var(--card)', border: '1px solid var(--border)',
              borderRadius: '1rem', padding: '1.5rem', width: '100%', maxWidth: '22rem',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {confirmAction === 'end' && (
              <>
                <p style={{ color: 'var(--text)', fontWeight: 600, marginBottom: '0.5rem' }}>End this event?</p>
                <p style={{ color: 'var(--muted)', fontSize: '0.875rem', marginBottom: '1.25rem' }}>
                  All open check-ins will be closed. This cannot be undone.
                </p>
                <div style={{ display: 'flex', gap: '0.75rem' }}>
                  <Btn onClick={() => setConfirmAction(null)}>Cancel</Btn>
                  <Btn danger onClick={doEnd}>End Event</Btn>
                </div>
              </>
            )}
            {confirmAction === 'pin' && (
              <>
                <p style={{ color: 'var(--text)', fontWeight: 600, marginBottom: '0.5rem' }}>Reset PIN?</p>
                <p style={{ color: 'var(--muted)', fontSize: '0.875rem', marginBottom: '1.25rem' }}>
                  A new PIN will be generated. The old one stops working immediately.
                </p>
                <div style={{ display: 'flex', gap: '0.75rem' }}>
                  <Btn onClick={() => setConfirmAction(null)}>Cancel</Btn>
                  <Btn onClick={doResetPin}>Generate New PIN</Btn>
                </div>
              </>
            )}
            {confirmAction === 'delete' && (
              <>
                <p style={{ color: 'var(--coral)', fontWeight: 700, marginBottom: '0.5rem' }}>
                  Permanently delete this event?
                </p>
                <p style={{ color: 'var(--muted)', fontSize: '0.875rem', marginBottom: '0.75rem' }}>
                  This removes the event, every check-in record, and all related
                  data. <strong style={{ color: 'var(--coral)' }}>This cannot be undone.</strong>
                </p>
                <p style={{ color: 'var(--muted)', fontSize: '0.8rem', marginBottom: '0.5rem' }}>
                  Type <code style={{ color: 'var(--coral)', fontWeight: 700 }}>DELETE</code> to confirm:
                </p>
                <input
                  type='text'
                  value={deleteConfirmText}
                  onChange={(e) => setDeleteConfirmText(e.target.value)}
                  placeholder='DELETE'
                  autoComplete='off'
                  autoCorrect='off'
                  spellCheck={false}
                  className='input-field'
                  style={{ fontSize: 14, padding: '8px 12px', marginBottom: '1rem' }}
                />
                <div style={{ display: 'flex', gap: '0.75rem' }}>
                  <Btn onClick={() => { setConfirmAction(null); setDeleteConfirmText('') }}>Cancel</Btn>
                  <Btn danger disabled={deleteConfirmText !== 'DELETE'} onClick={doDelete}>
                    Delete forever
                  </Btn>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Btn({ children, onClick, disabled, danger }: {
  children: React.ReactNode
  onClick: () => void
  disabled?: any
  danger?: boolean
}) {
  return (
    <button
      type='button' onClick={onClick} disabled={disabled}
      className='px-3 py-1.5 text-xs font-semibold cursor-pointer disabled:opacity-50'
      style={{
        background: danger ? 'rgba(232,96,74,0.12)' : 'var(--bg2)',
        color: danger ? 'var(--coral)' : 'var(--text)',
        border: `1.5px solid ${danger ? 'rgba(232,96,74,0.3)' : 'var(--border)'}`,
        borderRadius: 'var(--radius-btn)',
      }}
    >{children}</button>
  )
}
