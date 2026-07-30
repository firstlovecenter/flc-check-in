import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Label } from '../ui/label'
import { Input } from '../ui/input'
import { Button } from '../ui/button'

export default function PinEntry({ onSubmit, disabled = false, hint = null }) {
  const { t } = useTranslation()
  const [pin, setPin] = useState('')
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (pin.length !== 6) return
    onSubmit?.(pin)
  }
  return (
    <form onSubmit={handleSubmit} className='flex flex-col gap-3'>
      <Label className='text-xs font-semibold uppercase tracking-widest'>{t('checkin.pin.label')}</Label>
      <Input
        type='text'
        inputMode='numeric'
        pattern='[0-9]*'
        autoComplete='one-time-code'
        maxLength={6}
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        className='tnum rounded-xl py-4 text-center text-2xl tracking-[0.5em]'
        placeholder='••••••'
        disabled={disabled}
      />
      {hint && <p className='text-center text-xs text-muted-foreground'>{hint}</p>}
      <Button type='submit' disabled={disabled || pin.length !== 6} className='w-full' size='lg'>
        {t('checkin.pin.submit')}
      </Button>
    </form>
  )
}
