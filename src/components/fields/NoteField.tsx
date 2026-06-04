import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'

export default function NoteField({ field, value, onChange }) {
  return (
    <div className='flex flex-col gap-2'>
      <Label>{field.label}</Label>
      <Textarea
        rows={3}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder='Add a note...'
        className='min-h-0 resize-none'
      />
    </div>
  )
}
