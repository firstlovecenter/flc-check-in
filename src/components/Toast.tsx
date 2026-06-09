import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/utils'

// Lightweight transient feedback. Module-level emitter so any code (screens,
// utils, hooks) can fire a toast without threading context through the tree;
// <ToastHost /> is mounted once in App.tsx and renders the stack.

export type ToastVariant = 'success' | 'error' | 'info'

interface ToastItem {
  id: number
  message: string
  variant: ToastVariant
}

type Listener = (t: ToastItem) => void
let listener: Listener | null = null
let nextId = 1

export function toast(message: string, variant: ToastVariant = 'info') {
  listener?.({ id: nextId++, message, variant })
}

const TOAST_MS = 3500
const MAX_VISIBLE = 3

export function ToastHost() {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  useEffect(() => {
    listener = (t) => {
      setToasts((prev) => [...prev.slice(-(MAX_VISIBLE - 1)), t])
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== t.id))
      }, TOAST_MS)
    }
    return () => { listener = null }
  }, [])

  if (toasts.length === 0) return null
  return createPortal(
    <div
      className='pointer-events-none fixed inset-x-0 z-[70] flex flex-col items-center gap-2 px-4'
      style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 20px)' }}
      role='status'
      aria-live='polite'
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'toast-item pointer-events-auto',
            t.variant === 'success' && 'toast-item--success',
            t.variant === 'error' && 'toast-item--error',
          )}
        >
          {t.message}
        </div>
      ))}
    </div>,
    document.body,
  )
}
