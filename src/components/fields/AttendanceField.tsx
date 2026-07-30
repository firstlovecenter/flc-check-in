import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Label } from '../ui/label'
import { cn } from '../../lib/utils'

export default function AttendanceField({ field, value, onChange, error }) {
  const { t } = useTranslation()
  const count = value ?? 0
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

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
    setTimeout(() => inputRef.current?.select(), 0)
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value.replace(/\D/g, '')
    onChange(raw === '' ? 0 : Math.min(Number(raw), 9999))
  }

  function handleBlur() {
    setEditing(false)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') inputRef.current?.blur()
  }

  return (
    <div className='flex flex-col gap-2'>
      <Label>
        {field.label}
        {field.required && <span className='text-destructive'>*</span>}
      </Label>
      <div
        className={cn(
          'surface-card flex items-center overflow-hidden rounded-lg p-0',
          error && 'border-destructive',
          !error && isBelowThreshold && 'border-warning',
        )}
      >
        <button
          type='button'
          onClick={decrement}
          className={cn(
            'flex size-16 shrink-0 cursor-pointer select-none items-center justify-center text-2xl font-light',
            count > 0 ? 'text-foreground' : 'text-border',
          )}
        >
          −
        </button>

        <div className='flex min-h-16 flex-1 items-center justify-center'>
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
              className='tnum w-full border-0 bg-transparent text-center text-4xl font-semibold text-primary outline-none caret-primary'
            />
          ) : (
            <button
              type='button'
              onClick={handleTapNumber}
              title={t('fields.attendanceTapHint')}
              className='flex h-full w-full cursor-text select-none items-center justify-center border-0 bg-transparent p-0'
            >
              <span
                className={cn(
                  'tnum text-4xl font-semibold',
                  count === 0 ? 'text-muted-foreground' : 'text-foreground',
                )}
              >
                {count}
              </span>
            </button>
          )}
        </div>

        <button
          type='button'
          onClick={increment}
          className='flex size-16 shrink-0 cursor-pointer select-none items-center justify-center text-2xl font-light text-primary'
        >
          +
        </button>
      </div>
      <p className='-mt-1 text-xs text-muted-foreground'>{t('fields.attendanceTapHint')}</p>
      {isBelowThreshold && !error && (
        <p className='m-0 mt-0.5 text-xs text-warning'>
          {t('fields.attendanceBelow', { threshold })}
        </p>
      )}
      {error && <p className='field-error'>{error}</p>}
    </div>
  )
}
