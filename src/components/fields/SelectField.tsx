// SelectField — large tap-target button group (not a native dropdown)
// field.options: string[]

export default function SelectField({ field, value, onChange, error }) {
  return (
    <div className='flex flex-col gap-2'>
      <label className='eyebrow' style={{ color: 'var(--muted)' }}>
        {field.label}
        {field.required && <span style={{ color: 'var(--coral)' }}>*</span>}
      </label>

      <div className='flex flex-col gap-2'>
        {(field.options || []).map((opt) => {
          const selected = value === opt
          return (
            <button
              key={opt}
              type='button'
              onClick={() => onChange(opt)}
              className='w-full py-4 px-5 text-left text-base font-semibold cursor-pointer transition-all'
              style={{
                background: selected ? 'var(--cta-bg)' : 'var(--card)',
                border: selected ? '1.5px solid var(--cta-bg)' : '1.5px solid var(--border)',
                borderRadius: 'var(--radius-btn)',
                color: selected ? 'var(--cta-text)' : 'var(--text)',
                letterSpacing: '-0.01em',
              }}
            >
              {selected && <span className='mr-2'>✓</span>}
              {opt}
            </button>
          )
        })}
      </div>

      {error && <p className='text-xs mt-0.5 m-0' style={{ color: 'var(--coral)' }}>{error}</p>}
    </div>
  )
}
