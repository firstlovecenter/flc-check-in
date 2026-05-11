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
  const [busy, setBusy] = useState<string | null>(null)

  async function run(label: string, fn: () => Promise<CheckinEventRow>) {
    setBusy(label)
    try {
      const updated = await fn()
      onChange?.(updated)
    } catch (err: any) {
      alert(err.message || 'Action failed')
    } finally {
      setBusy(null)
    }
  }

  async function handleExtend(minutes) {
    const newEnds = new Date(new Date(event.ends_at).getTime() + minutes * 60_000)
    await run(`extend-${minutes}`, () => extendEvent(event.id, newEnds))
  }

  async function handleResetPin() {
    if (!confirm('Generate a new PIN? The old one stops working immediately.')) return
    const newPin = generatePin()
    setBusy('pin')
    try {
      await resetPin(event.id, newPin)
      alert(`New PIN: ${newPin}`)
    } catch (err: any) {
      alert(err.message || 'Reset failed')
    } finally {
      setBusy(null)
    }
  }

  async function handleEnd() {
    if (!confirm('End this event now? All open check-ins will be closed.')) return
    await run('end', () => endEvent(event.id))
  }

  return (
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
            <Btn disabled={busy} onClick={handleResetPin}>{busy === 'pin' ? '…' : 'Reset PIN'}</Btn>
          )}
          <Btn disabled={busy} danger onClick={handleEnd}>{busy === 'end' ? '…' : 'End'}</Btn>
        </>
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
