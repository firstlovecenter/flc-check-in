// Strict device fingerprint — combines FingerprintJS visitorId with several
// hardware-level signals (canvas, WebGL, screen, CPU, memory, timezone, media
// device IDs) and hashes the result with SHA-256.
// Persisted in localStorage (stable across sessions) and sessionStorage (fast
// intra-session access).  API is unchanged — callers get a 64-char hex string.

import FingerprintJS from '@fingerprintjs/fingerprintjs'

const SESSION_KEY = 'flc.checkin.fp.session'
const LOCAL_KEY   = 'flc.checkin.fp.local'
let pending: Promise<string> | null = null

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
  const [canvas, media] = await Promise.all([
    Promise.resolve(canvasSignal()),
    mediaDeviceSignal(),
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
  ].join('||')
  return sha256hex(signals)
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

  pending = (async () => {
    const agent = await FingerprintJS.load()
    const { visitorId } = await agent.get()
    const fp = await computeStrictFingerprint(visitorId)
    sessionStorage.setItem(SESSION_KEY, fp)
    localStorage.setItem(LOCAL_KEY, fp)
    return fp
  })().finally(() => { pending = null })

  // Return the persisted value immediately while recomputing so callers
  // aren't blocked on media-device enumeration on first page load.
  const persisted = localStorage.getItem(LOCAL_KEY)
  if (persisted) {
    void pending  // let it update in the background
    return persisted
  }

  return pending
}
