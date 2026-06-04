import type { ReactNode } from 'react'
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
  if (!open) return null
  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center p-4'>
      <div className='drawer-backdrop fixed inset-0' onClick={onClose} aria-hidden />
      <div
        role='dialog'
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
