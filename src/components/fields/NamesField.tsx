export default function NamesField({ field, value, onChange, error }) {
  return (
    <div className='flex flex-col gap-2'>
      <label className='eyebrow' style={{ color: 'var(--muted)' }}>
        {field.label}
        {field.required && <span style={{ color: 'var(--coral)' }}>*</span>}
      </label>
      <textarea
        rows={4}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={'Name 1\nName 2\nName 3'}
        className='w-full resize-none px-4 py-3 text-sm outline-none'
        style={{
          background: 'var(--bg2)',
          border: error ? '1.5px solid var(--coral)' : '1.5px solid var(--border)',
          borderRadius: 'var(--radius-btn)',
          color: 'var(--text)',
          caretColor: 'var(--accent)',
          fontFamily: 'var(--sans)',
        }}
      />
      {error && <p className='text-xs mt-0.5 m-0' style={{ color: 'var(--coral)' }}>{error}</p>}
    </div>
  )
}
