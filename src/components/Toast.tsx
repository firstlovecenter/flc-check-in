import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/utils'

// Lightweight transient feedback. Module-level emitter so any code (screens,
// utils, hooks) can fire a toast without threading context through the tree;
// <ToastHost /> is mounted once in App.tsx and renders the stack.
//
// Pass `id` to dedupe (portal/sonner pattern): a second toast with the same id
// replaces the first instead of stacking — critical when retries fire.

export type ToastVariant = 'success' | 'error' | 'info'

interface ToastItem {
  id: string
  message: string
  variant: ToastVariant
}

type Listener = (t: ToastItem) => void
let listener: Listener | null = null
let nextId = 1

export function toast(
  message: string,
  variant: ToastVariant = 'info',
  opts?: { id?: string },
) {
  listener?.({
    id: opts?.id ?? `toast-${nextId++}`,
    message,
    variant,
  })
}

const TOAST_MS = 3500
const MAX_VISIBLE = 3

export function ToastHost() {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  useEffect(() => {
    const timers = new Map<string, number>()
    listener = (t) => {
      setToasts((prev) => {
        const without = prev.filter((x) => x.id !== t.id)
        return [...without.slice(-(MAX_VISIBLE - 1)), t]
      })
      const existing = timers.get(t.id)
      if (existing) window.clearTimeout(existing)
      timers.set(t.id, window.setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== t.id))
        timers.delete(t.id)
      }, TOAST_MS))
    }
    return () => {
      listener = null
      for (const id of timers.values()) window.clearTimeout(id)
    }
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
