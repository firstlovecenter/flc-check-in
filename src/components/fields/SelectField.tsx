import { Label } from '../ui/label'
import { cn } from '../../lib/utils'

export default function SelectField({ field, value, onChange, error }) {
  return (
    <div className='flex flex-col gap-2'>
      <Label>
        {field.label}
        {field.required && <span className='text-destructive'>*</span>}
      </Label>

      <div className='flex flex-col gap-2'>
        {(field.options || []).map((opt) => {
          const selected = value === opt
          return (
            <button
              key={opt}
              type='button'
              onClick={() => onChange(opt)}
              className={cn('choice-option cursor-pointer transition-[color,background-color,border-color,transform]', selected && 'choice-option--selected')}
            >
              {selected && <span className='mr-2'>✓</span>}
              {opt}
            </button>
          )
        })}
      </div>

      {error && <p className='field-error'>{error}</p>}
    </div>
  )
}
