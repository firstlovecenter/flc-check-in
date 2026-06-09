import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '../../lib/utils'

interface ModalProps {
  open: boolean
  onClose: () => void
  children: ReactNode
  className?: string
  /** Centered dialog (default) or bottom sheet */
  variant?: 'center' | 'sheet'
}

export function Modal({ open, onClose, children, className, variant = 'center' }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null)

  // Basic dialog a11y: focus moves into the dialog on open, Escape closes,
  // Tab cycles within the dialog (simple focus trap), and focus returns to
  // the previously focused element on close.
  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current
    const focusables = () =>
      dialog?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      ) ?? []
    ;(focusables()[0] ?? dialog)?.focus()

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const items = [...focusables()]
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus?.()
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center p-4'>
      <div className='drawer-backdrop fixed inset-0' onClick={onClose} aria-hidden />
      <div
        ref={dialogRef}
        role='dialog'
        aria-modal='true'
        tabIndex={-1}
        className={cn(
          'relative z-10 w-full max-w-lg border border-border bg-card shadow-lg',
          variant === 'center' ? 'modal-card rounded-xl p-6' : 'sheet-card rounded-t-xl p-6 max-w-lg',
          className,
        )}
      >
        {children}
      </div>
    </div>
  )
}
