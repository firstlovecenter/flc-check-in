// Global "user wants to refresh this screen" signal.
//
// Why this exists
// ---------------
// Pull-to-refresh only fires on touch devices over the home screen — every
// other screen had no way for the user to ask for fresh data. This module
// gives every screen a single hook to subscribe to a global refresh signal,
// and any UI element (TopBar / ScreenHeader refresh button, future cmd-R
// binding, etc.) can publish it.
//
// Implementation: a CustomEvent on `window`. Tiny, no provider, no context,
// works across the entire app. Each subscriber gets called in mount order;
// publishing is cheap (synchronous dispatch).
//
// Usage
// -----
// In a screen:
//   useRefreshSignal(() => { reloadMyData() })
//
// Anywhere (button, keyboard handler, polling watchdog):
//   triggerRefresh()

import { useEffect, useRef } from 'react'

const EVENT_NAME = 'flc:refresh'

/** Publish a refresh signal. Every component subscribed via useRefreshSignal
 *  will run its callback. No-op if called outside a browser. */
export function triggerRefresh(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(EVENT_NAME))
}

/** Subscribe to refresh signals. The callback is called on every dispatch.
 *  Always reads the latest closure-captured handler via a ref, so callers
 *  can pass inline functions without re-subscribing on every render. */
export function useRefreshSignal(handler: () => void): void {
  const ref = useRef(handler)
  useEffect(() => { ref.current = handler }, [handler])

  useEffect(() => {
    const fn = () => ref.current()
    window.addEventListener(EVENT_NAME, fn)
    return () => window.removeEventListener(EVENT_NAME, fn)
  }, [])
}
