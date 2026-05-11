import { useRef, useState } from 'react'

export default function AttendanceField({ field, value, onChange, error }) {
  const count = value ?? 0
  const [editing, setEditing] = useState(false)
  const inputRef = useRef(null)

  // flagBelow: if set to a number, show a warning when count > 0 and count < threshold
  const threshold = typeof field.flagBelow === 'number' ? field.flagBelow : null
  const isBelowThreshold = threshold !== null && count > 0 && count < threshold

  function decrement() {
    if (count > 0) onChange(count - 1)
  }
  function increment() {
    onChange(count + 1)
  }

  function handleTapNumber() {
    setEditing(true)
    // Give React a tick to render the input before focusing
    setTimeout(() => inputRef.current?.select(), 0)
  }

  function handleInputChange(e) {
    const raw = e.target.value.replace(/\D/g, '')
    onChange(raw === '' ? 0 : Math.min(Number(raw), 9999))
  }

  function handleBlur() {
    setEditing(false)
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') inputRef.current?.blur()
  }

  return (
    <div className='flex flex-col gap-2'>
      <label
        className='eyebrow'
        style={{ color: 'var(--muted)' }}
      >
        {field.label}
        {field.required && <span style={{ color: 'var(--coral)' }}>*</span>}
      </label>
      <div
        className='flex items-center overflow-hidden'
        style={{
          background: 'var(--card)',
          border: error ? '1.5px solid var(--coral)' : isBelowThreshold ? '1.5px solid var(--amber)' : '1.5px solid var(--border)',
          borderRadius: 'var(--radius-btn)',
        }}
      >
        {/* Decrement */}
        <button
          type='button'
          onClick={decrement}
          className='flex items-center justify-center text-2xl font-light select-none cursor-pointer flex-shrink-0'
          style={{ width: 64, height: 64, color: count > 0 ? 'var(--text)' : 'var(--border)' }}
        >
          −
        </button>

        {/* Centre — tap to type */}
        <div className='flex-1 flex items-center justify-center' style={{ minHeight: 64 }}>
          {editing ? (
            <input
              ref={inputRef}
              type='number'
              inputMode='numeric'
              pattern='[0-9]*'
              value={count === 0 ? '' : count}
              onChange={handleInputChange}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              className='text-4xl font-semibold tabular-nums text-center bg-transparent outline-none w-full'
              style={{ color: 'var(--accent)', caretColor: 'var(--accent)' }}
            />
          ) : (
            <button
              type='button'
              onClick={handleTapNumber}
              title='Tap to type a number'
              className='flex items-center justify-center w-full h-full cursor-text select-none'
              style={{ background: 'none', border: 'none', padding: 0 }}
            >
              <span
                className='text-4xl font-semibold tabular-nums'
                style={{ color: count === 0 ? 'var(--muted)' : 'var(--text)' }}
              >
                {count}
              </span>
            </button>
          )}
        </div>

        {/* Increment */}
        <button
          type='button'
          onClick={increment}
          className='flex items-center justify-center text-2xl font-light select-none cursor-pointer flex-shrink-0'
          style={{ width: 64, height: 64, color: 'var(--accent)' }}
        >
          +
        </button>
      </div>
      <p className='text-xs' style={{ color: 'var(--muted)', marginTop: -4 }}>
        Tap the number to type it directly
      </p>
      {isBelowThreshold && !error && (
        <p className='text-xs mt-0.5 m-0' style={{ color: 'var(--amber)' }}>
          Target is {threshold} — you're below the minimum
        </p>
      )}
      {error && <p className='text-xs mt-0.5 m-0' style={{ color: 'var(--coral)' }}>{error}</p>}
    </div>
  )
}
