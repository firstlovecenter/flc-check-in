import { useRef } from 'react'

export default function PhotoField({ field, value, onChange }) {
  const inputRef = useRef(null)

  function handleFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => onChange({ dataUrl: ev.target.result, name: file.name, file })
    reader.readAsDataURL(file)
  }

  function handleClear(e) {
    e.stopPropagation()
    onChange(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div className='flex flex-col gap-2'>
      <label className='eyebrow' style={{ color: 'var(--muted)' }}>
        {field.label}
      </label>

      {value?.dataUrl ? (
        <div
          className='relative overflow-hidden'
          style={{ border: '1.5px solid var(--border)', borderRadius: 'var(--radius-btn)' }}
        >
          <img
            src={value.dataUrl}
            alt='Preview'
            className='w-full object-cover'
            style={{ maxHeight: 220 }}
          />
          <button
            type='button'
            onClick={handleClear}
            className='absolute top-2 right-2 flex items-center justify-center text-xs font-bold cursor-pointer'
            style={{
              width: 28, height: 28,
              background: 'rgba(0,0,0,0.6)',
              color: '#fff',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '50%',
            }}
          >
            ✕
          </button>
        </div>
      ) : (
        <button
          type='button'
          onClick={() => inputRef.current?.click()}
          className='flex items-center gap-4 px-4 py-4 cursor-pointer w-full text-left'
          style={{
            background: 'var(--bg2)',
            border: '1.5px solid var(--border)',
            borderRadius: 'var(--radius-btn)',
          }}
        >
          <div
            className='flex items-center justify-center text-2xl flex-shrink-0'
            style={{ width: 48, height: 48, background: 'var(--card)', borderRadius: 'var(--radius-sm)' }}
          >
            📷
          </div>
          <div>
            <p className='m-0 text-sm font-semibold' style={{ color: 'var(--text)' }}>
              Add a photo
            </p>
            <p className='m-0 text-xs mt-0.5' style={{ color: 'var(--muted)' }}>
              Take a photo or upload from gallery
            </p>
          </div>
        </button>
      )}

      <input
        ref={inputRef}
        type='file'
        accept='image/*'
        capture='environment'
        className='hidden'
        onChange={handleFile}
      />
    </div>
  )
}
