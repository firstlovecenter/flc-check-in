import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Label } from '../ui/label'
import { Button } from '../ui/button'

export default function PhotoField({ field, value, onChange }) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => onChange({ dataUrl: ev.target?.result, name: file.name, file })
    reader.readAsDataURL(file)
  }

  function handleClear(e: React.MouseEvent) {
    e.stopPropagation()
    onChange(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div className='flex flex-col gap-2'>
      <Label>{field.label}</Label>

      {value?.dataUrl ? (
        <div className='surface-card relative overflow-hidden rounded-lg p-0'>
          <img src={value.dataUrl} alt={t('fields.photoPreviewAlt')} className='max-h-[220px] w-full object-cover' />
          <Button
            type='button'
            variant='secondary'
            size='icon-sm'
            onClick={handleClear}
            className='absolute right-2 top-2 size-7 rounded-full bg-foreground/60 text-primary-foreground hover:bg-foreground/70'
            aria-label={t('fields.photoRemoveAria')}
          >
            ✕
          </Button>
        </div>
      ) : (
        <button
          type='button'
          onClick={() => inputRef.current?.click()}
          className='surface-card flex w-full cursor-pointer items-center gap-4 px-4 py-4 text-left transition-colors hover:border-primary/35'
        >
          <div className='flex size-12 shrink-0 items-center justify-center rounded-md bg-secondary text-2xl'>
            📷
          </div>
          <div>
            <p className='m-0 text-sm font-semibold text-foreground'>{t('fields.photoAdd')}</p>
            <p className='m-0 mt-0.5 text-xs text-muted-foreground'>
              {t('fields.photoHint')}
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
