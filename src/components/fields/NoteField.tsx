export default function NoteField({ field, value, onChange }) {
  return (
    <div className='flex flex-col gap-2'>
      <label className='eyebrow' style={{ color: 'var(--muted)' }}>
        {field.label}
      </label>
      <textarea
        rows={3}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder='Add a note...'
        className='w-full resize-none px-4 py-3 text-sm outline-none'
        style={{
          background: 'var(--bg2)',
          border: '1.5px solid var(--border)',
          borderRadius: 'var(--radius-btn)',
          color: 'var(--text)',
          caretColor: 'var(--accent)',
          fontFamily: 'var(--sans)',
        }}
      />
    </div>
  )
}
