import { useState } from 'react'
import {
  pauseEvent, resumeEvent, endEvent, extendEvent, resetPin,
} from '../../utils/supabaseCheckins'
import { generatePin } from '../../utils/checkinsCrypto'
import type { CheckinEventRow } from '../../types/app'

interface Props {
  event: CheckinEventRow
  onChange?: (event: CheckinEventRow) => void
}

export default function CheckInAdminControls({ event, onChange }: Props) {
  const [busy, setBusy]         = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // Inline confirmation — stores the pending action id ('end' | 'pin').
  const [confirmAction, setConfirmAction] = useState<'end' | 'pin' | null>(null)
  // The newly generated PIN to display inline instead of alert().
  const [newPinDisplay, setNewPinDisplay] = useState<string | null>(null)

  async function run(label: string, fn: () => Promise<CheckinEventRow>) {
    setBusy(label)
    setActionError(null)
    try {
      const updated = await fn()
      onChange?.(updated)
    } catch (err: any) {
      setActionError(err.message || 'Action failed')
    } finally {
      setBusy(null)
    }
  }

  async function handleExtend(minutes: number) {
    const newEnds = new Date(new Date(event.ends_at).getTime() + minutes * 60_000)
    await run(`extend-${minutes}`, () => extendEvent(event.id, newEnds))
  }

  async function doResetPin() {
    setConfirmAction(null)
    const pin = generatePin()
    setBusy('pin')
    setActionError(null)
    try {
      await resetPin(event.id, pin)
      setNewPinDisplay(pin)
    } catch (err: any) {
      setActionError(err.message || 'Reset failed')
    } finally {
      setBusy(null)
    }
  }

  async function doEnd() {
    setConfirmAction(null)
    await run('end', () => endEvent(event.id))
  }

  return (
    <div>
      <div className='flex flex-wrap gap-2'>
        {event.status === 'ACTIVE' && (
          <Btn disabled={busy} onClick={() => run('pause', () => pauseEvent(event.id))}>
            {busy === 'pause' ? '…' : 'Pause'}
          </Btn>
        )}
        {event.status === 'PAUSED' && (
          <Btn disabled={busy} onClick={() => run('resume', () => resumeEvent(event.id))}>
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
            {confirmAction === 'end' ? (
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
            ) : (
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
