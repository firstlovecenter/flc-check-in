import { useTranslation } from 'react-i18next'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'
import { cn } from '../../lib/utils'

export default function NamesField({ field, value, onChange, error }) {
  const { t } = useTranslation()
  return (
    <div className='flex flex-col gap-2'>
      <Label>
        {field.label}
        {field.required && <span className='text-destructive'>*</span>}
      </Label>
      <Textarea
        rows={4}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('fields.namesPlaceholder')}
        className={cn('min-h-0 resize-none', error && 'border-destructive focus:border-destructive focus:ring-destructive/20')}
      />
      {error && <p className='field-error'>{error}</p>}
    </div>
  )
}
