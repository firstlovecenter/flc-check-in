// Tiny haptic feedback helper. navigator.vibrate is Android/Chrome only —
// iOS Safari ignores it — so this is strictly progressive enhancement.
export function vibrate(pattern: number | number[] = 10) {
  try { navigator.vibrate?.(pattern) } catch { /* unsupported */ }
}

/** Short double-tap pattern for a confirmed action (e.g. check-in landed). */
export function vibrateSuccess() {
  vibrate([15, 60, 25])
}
