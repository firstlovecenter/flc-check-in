// Strict device fingerprint — combines FingerprintJS visitorId with several
// hardware-level signals (canvas, WebGL, screen, CPU, memory, timezone, media
// device IDs) plus a random per-install ID (getInstallId — prevents same-model
// phones colliding) and hashes the result with SHA-256.
// Persisted in localStorage (stable across sessions) and sessionStorage (fast
// intra-session access).  API is unchanged — callers get a 64-char hex string.
//
// FingerprintJS (~50KB) is imported dynamically so it is only downloaded the
// first time a fingerprint actually has to be computed — cached/persisted
// fingerprints never pay for it.

const SESSION_KEY = 'flc.checkin.fp.session'
const LOCAL_KEY   = 'flc.checkin.fp.local'
const INSTALL_KEY = 'flc.checkin.installId'
let pending: Promise<string> | null = null

/** A random ID minted once per install and folded into the fingerprint.
 *
 *  Hardware/browser signals alone are identical on same-model phones running
 *  the same software, so two genuine leaders could hash to one fingerprint and
 *  the second be told "device already used" at the door. A per-install random
 *  value makes every install unique. Trade-off, chosen deliberately: clearing
 *  the site's data now yields a new fingerprint (a determined user could use
 *  that to check in someone else) — wrongly blocking real attendees was judged
 *  the worse failure. The native app additionally folds in the OS device ID. */
export function getInstallId(): string {
  try {
    const existing = localStorage.getItem(INSTALL_KEY)
    if (existing) return existing
    const id = typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
    localStorage.setItem(INSTALL_KEY, id)
    return id
  } catch {
    // Storage blocked (some private modes): unique per page load, which still
    // avoids collisions; the fingerprint isn't persisted there anyway.
    return `ephemeral:${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  }
}

// ---------------------------------------------------------------------------
// Signal collectors
// ---------------------------------------------------------------------------

function canvasSignal(): string {
  try {
    const c = document.createElement('canvas')
    c.width = 280; c.height = 60
    const ctx = c.getContext('2d')!
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = '#f16'
    ctx.fillRect(100, 1, 80, 20)
    ctx.fillStyle = '#069'
    ctx.font = '11pt Arial'
    ctx.fillText('FLC cheçk-ïn 😀 ① Ω', 2, 15)
    ctx.fillStyle = 'rgba(0,200,100,0.7)'
    ctx.font = '16pt serif'
    ctx.fillText('Cwm fjordbank', 4, 50)
    return c.toDataURL()
  } catch {
    return 'canvas:unavailable'
  }
}

function webglSignal(): string {
  try {
    const c = document.createElement('canvas')
    const gl = (c.getContext('webgl') ??
      c.getContext('experimental-webgl')) as WebGLRenderingContext | null
    if (!gl) return 'webgl:unavailable'
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const vendor   = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)   : gl.getParameter(gl.VENDOR)
    const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
    // also fold in supported extension count as extra entropy
    const extCount = gl.getSupportedExtensions()?.length ?? 0
    return `${vendor}|${renderer}|${extCount}`
  } catch {
    return 'webgl:unavailable'
  }
}

async function mediaDeviceSignal(): Promise<string> {
  try {
    // deviceId is stable per-browser-profile once camera/mic has been granted.
    // We only collect IDs (never labels) — no additional permission needed.
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices
      .map((d) => `${d.kind}:${d.deviceId}`)
      .filter((s) => !s.endsWith(':'))   // skip empty IDs (permission not yet granted)
      .sort()
      .join(',')
  } catch {
    return 'media:unavailable'
  }
}

// In the native (Capacitor) app, fold in the OS-level per-install identifier
// (ANDROID_ID / iOS identifierForVendor). Two units of the same device model
// running the identical WebView can otherwise produce near-identical signals
// (canvas/WebGL/screen/CPU all match) and collide — surfacing as false
// "device shared across members" risk flags. The native ID is collision-proof
// and needs no permissions. Returns '' on the web so the browser fingerprint
// formula (and therefore existing persisted fingerprints) is unchanged.
async function nativeDeviceIdSignal(): Promise<string> {
  let isNative = false
  try {
    const { Capacitor } = await import('@capacitor/core')
    isNative = Capacitor.isNativePlatform()
    if (!isNative) return ''
    const { Device } = await import('@capacitor/device')
    const { identifier } = await Device.getId()
    return identifier ? `nativeId:${identifier}` : ''
  } catch (err) {
    // On native this silently degrades to the web formula AND the result is
    // frozen in localStorage — surface it so degraded installs are diagnosable.
    if (isNative) console.warn('[fingerprint] native device ID unavailable, using web formula:', err)
    return ''
  }
}

async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input),
  )
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function computeStrictFingerprint(visitorId: string): Promise<string> {
  const nav = navigator
  const scr = screen
  const [canvas, media, nativeId] = await Promise.all([
    Promise.resolve(canvasSignal()),
    mediaDeviceSignal(),
    nativeDeviceIdSignal(),
  ])
  const signals = [
    visitorId,
    canvas,
    webglSignal(),
    `scr:${scr.width}x${scr.height}x${scr.colorDepth}x${scr.pixelDepth}`,
    `dpr:${window.devicePixelRatio ?? 1}`,
    `mem:${(nav as Navigator & { deviceMemory?: number }).deviceMemory ?? '?'}`,
    `cpu:${nav.hardwareConcurrency ?? '?'}`,
    `touch:${nav.maxTouchPoints ?? 0}`,
    `plat:${nav.platform ?? '?'}`,
    `lang:${nav.language ?? '?'}`,
    `tz:${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    media,
    // Per-install uniqueness — see getInstallId. Only affects NEW fingerprints:
    // phones that already stored one keep it (getDeviceFingerprint returns the
    // persisted value first), so existing device claims are undisturbed.
    `inst:${getInstallId()}`,
  ]
  if (nativeId) signals.push(nativeId)
  return sha256hex(signals.join('||'))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getDeviceFingerprint(): Promise<string> {
  // Fast path — serve from session cache within the same tab.
  const session = sessionStorage.getItem(SESSION_KEY)
  if (session) return session

  // Deduplicate concurrent callers (e.g. QR + PIN handlers racing on mount).
  if (pending) return pending

  // Use the previously-persisted fingerprint if available so every call
  // within this session returns IDENTICAL bytes. Recomputing in-session is
  // both wasteful and dangerous — it can flip the bytes (e.g. when camera
  // permission is granted between calls), breaking the server's per-event
  // device claim (which key on the exact fingerprint string).
  //
  // The persisted value is refreshed only when nothing was stored before
  // (genuine first run) or when explicitly invalidated by the caller via
  // resetDeviceFingerprint().
  const persisted = localStorage.getItem(LOCAL_KEY)
  if (persisted) {
    sessionStorage.setItem(SESSION_KEY, persisted)
    return persisted
  }

  pending = (async () => {
    const { default: FingerprintJS } = await import('@fingerprintjs/fingerprintjs')
    const agent = await FingerprintJS.load()
    const { visitorId } = await agent.get()
    const fp = await computeStrictFingerprint(visitorId)
    sessionStorage.setItem(SESSION_KEY, fp)
    localStorage.setItem(LOCAL_KEY, fp)
    return fp
  })().finally(() => { pending = null })

  return pending
}

/** Compute the fingerprint ahead of submit, but only when that cannot weaken
 *  it. The fingerprint is computed ONCE per install and frozen, and one of its
 *  signals (media device IDs) is empty until camera permission is granted —
 *  so computing it before the camera opens would freeze a lower-entropy value
 *  forever, making same-model phones likelier to collide. If it is already
 *  stored, or the camera is already permitted, warming is free and safe;
 *  otherwise leave it to submit, which runs after the QR scan. */
export async function warmDeviceFingerprint(): Promise<void> {
  if (sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(LOCAL_KEY)) {
    await getDeviceFingerprint()
    return
  }
  try {
    const status = await navigator.permissions?.query({ name: 'camera' as PermissionName })
    if (status?.state === 'granted') await getDeviceFingerprint()
  } catch { /* permissions API unsupported (e.g. older Safari) — skip */ }
}

/** Invalidate the persisted fingerprint. Useful after a clear-data action
 *  or when an admin wants to free a stuck (event, fingerprint) claim for
 *  testing. Not exposed to end users. */
export function resetDeviceFingerprint(): void {
  sessionStorage.removeItem(SESSION_KEY)
  localStorage.removeItem(LOCAL_KEY)
}
