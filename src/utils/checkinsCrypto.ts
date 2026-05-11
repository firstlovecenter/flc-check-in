// PIN + QR token primitives.
//
// PINs are hashed server-side via pgcrypto crypt(); the client only ever
// sends the plain PIN to the record_pin_attempt RPC. The two PIN helpers
// here (`generatePin`, `hashPin` via bcryptjs) exist so an admin client can
// preview the PIN at create time and so we have a fallback if the RPC ever
// goes away.
//
// QR tokens use HMAC-SHA256 with a 60-second rotating bucket. Both client
// (when displaying the QR) and server (when verifying) compute the same
// bucket from wall-clock time and the event's qr_secret.

import bcrypt from 'bcryptjs'

// ─── PIN ──────────────────────────────────────────────────────────────────
export function generatePin() {
  // 6 digits, zero-padded. Uses crypto.getRandomValues for unbiased range.
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return String(buf[0] % 1_000_000).padStart(6, '0')
}

export async function hashPin(plain) {
  return bcrypt.hash(plain, 10)
}

export async function verifyPin(plain, hash) {
  return bcrypt.compare(plain, hash)
}

// ─── QR ───────────────────────────────────────────────────────────────────
// 32 random bytes → hex. Server stores as bytea; we send hex over the wire
// at create time so the SQL function can decode().
export function generateQrSecretHex() {
  const buf = new Uint8Array(32)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function currentBucket(date = Date.now(), windowSec = 60) {
  return Math.floor(date / 1000 / windowSec)
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16)
  }
  return out
}

function bytesToHex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function hmacSha256Hex(secretBytes, messageStr) {
  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(messageStr))
  return bytesToHex(sig)
}

// QR payload: `eventId:bucket:hmacHex` — easy to scan and parse.
export async function generateQrToken({ secretHex, eventId, bucket = currentBucket() }) {
  const secretBytes = hexToBytes(secretHex)
  const message = `${eventId}:${bucket}`
  const sig = await hmacSha256Hex(secretBytes, message)
  return `${eventId}:${bucket}:${sig}`
}

function constantTimeEqualHex(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Accepts current and previous bucket so a scan during rotation isn't rejected.
export async function verifyQrToken(token, secretHex, eventId) {
  if (typeof token !== 'string') return false
  const parts = token.split(':')
  if (parts.length !== 3) return false
  const [tokenEventId, bucketStr, sig] = parts
  if (tokenEventId !== eventId) return false
  const bucket = Number(bucketStr)
  if (!Number.isFinite(bucket)) return false

  const secretBytes = hexToBytes(secretHex)
  const now = currentBucket()
  if (bucket !== now && bucket !== now - 1) return false

  const expected = await hmacSha256Hex(secretBytes, `${eventId}:${bucket}`)
  return constantTimeEqualHex(expected, sig)
}

// ─── Rotating PIN ──────────────────────────────────────────────────────────
// Derives a 6-digit OTP from the same HMAC used for QR tokens.
// Displayed on the /events public screen; rotates every 15 seconds.
// Server verifies with the same derivation (no stored PIN hash needed).
export async function generateRotatingPin({ secretHex, eventId, bucket = currentBucket(Date.now(), 15) }: {
  secretHex: string
  eventId: string
  bucket?: number
}) {
  const secretBytes = hexToBytes(secretHex)
  const sig = await hmacSha256Hex(secretBytes, `${eventId}:${bucket}`)
  // Last 4 bytes (8 hex chars) → unsigned 32-bit integer → mod 1,000,000
  const num = (parseInt(sig.slice(-8), 16) >>> 0) % 1_000_000
  return String(num).padStart(6, '0')
}
