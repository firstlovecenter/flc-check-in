import { useState } from 'react'

export default function PinEntry({ onSubmit, disabled = false, hint = null }) {
  const [pin, setPin] = useState('')
  function handleSubmit(e) {
    e.preventDefault()
    if (pin.length !== 6) return
    onSubmit?.(pin)
  }
  return (
    <form onSubmit={handleSubmit} className='flex flex-col gap-3'>
      <label className='text-xs font-semibold tracking-widest uppercase' style={{ color: 'var(--muted)' }}>
        6-digit PIN
      </label>
      <input
        type='text'
        inputMode='numeric'
        pattern='[0-9]*'
        autoComplete='one-time-code'
        maxLength={6}
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        className='w-full rounded-xl px-4 py-4 text-center text-2xl font-mono tracking-[0.5em] outline-none'
        style={{ background: 'var(--bg2)', border: '1px solid var(--border)', color: 'var(--text)' }}
        placeholder='••••••'
        disabled={disabled}
      />
      {hint && <p className='text-xs text-center' style={{ color: 'var(--muted)' }}>{hint}</p>}
      <button
        type='submit'
        disabled={disabled || pin.length !== 6}
        className='w-full rounded-xl py-3 text-sm font-semibold text-white disabled:opacity-50 cursor-pointer'
        style={{ background: 'var(--accent)' }}
      >
        Check in with PIN
      </button>
    </form>
  )
}
