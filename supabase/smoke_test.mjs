// Phase 1 smoke test — exercises every RPC and table against the new project.
// Run: node supabase/smoke_test.mjs
//
// Reads VITE_SUPABASE_URL + VITE_SUPABASE_PUBLISHABLE_KEY from .env.

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

function loadEnv() {
  const raw = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  const out = {}
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

const env = loadEnv()
const url = env.VITE_SUPABASE_URL
const key = env.VITE_SUPABASE_PUBLISHABLE_KEY
if (!url || !key) throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY in .env')
console.log('→ project:', url)

const supabase = createClient(url, key, { auth: { persistSession: false } })

const memberId = '7573ecf9-b445-40ce-ba24-5c8ed262bf82' // mock David Dag
const otherMemberId = '11111111-1111-1111-1111-111111111111'
const fingerprintA = 'fp-test-A'
const fingerprintB = 'fp-test-B'
let createdEventId = null

function step(label, ok, extra = '') {
  console.log(`${ok ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) process.exitCode = 1
}

async function main() {
  // ─── cleanup any leftovers from a prior run ────────────────────────────
  await supabase.from('checkin_events').delete().eq('name', 'SMOKE_TEST').then(({ error }) => {
    if (error && error.code !== 'PGRST116') console.warn('cleanup events:', error.message)
  })
  await supabase.from('member_profiles').delete().in('id', [memberId, otherMemberId])

  // ─── 1. upsert two member_profiles ─────────────────────────────────────
  {
    const { error } = await supabase.from('member_profiles').upsert([
      { id: memberId, email: 'smoke@flc.test', first_name: 'Smoke', last_name: 'Tester',
        roles: ['leaderBacenta','adminStream'], bacenta_id: 'b1', bacenta_name: 'God Chasers',
        stream_id: 's1', stream_name: 'Colossians' },
      { id: otherMemberId, email: 'other@flc.test', first_name: 'Other', last_name: 'Tester',
        roles: ['leaderBacenta'], bacenta_id: 'b1', bacenta_name: 'God Chasers' },
    ])
    step('upsert member_profiles (2 rows)', !error, error?.message || '')
  }

  // ─── 2. create_checkin_event RPC ────────────────────────────────────────
  {
    const startsAt = new Date(Date.now() - 60_000).toISOString()
    const endsAt = new Date(Date.now() + 60 * 60_000).toISOString()
    const qrSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    const { data, error } = await supabase.rpc('create_checkin_event', {
      p_name: 'SMOKE_TEST', p_event_type: 'meeting',
      p_scope_level: 'bacenta', p_scope_church_id: 'b1', p_scope_church_name: 'God Chasers',
      p_starts_at: startsAt, p_ends_at: endsAt,
      p_grace_period_min: 5, p_auto_checkout_min: 30,
      p_allowed_check_in_methods: ['QR','PIN','MANUAL'],
      p_allowed_roles: ['leaderBacenta','leaderGovernorship'],
      p_geofence_type: 'circle',
      p_geofence_center_lat: 5.6037, p_geofence_center_lng: -0.1870, p_geofence_radius_m: 100,
      p_geofence_polygon: null,
      p_pin_plain: '123456',
      p_qr_secret_hex: qrSecret,
      p_created_by_id: memberId, p_created_by_name: 'Smoke Tester',
    })
    createdEventId = data
    step('create_checkin_event RPC', !error && !!createdEventId, error?.message || `id=${createdEventId}`)
  }
  if (!createdEventId) return

  // ─── 3. point_in_event_geofence ────────────────────────────────────────
  {
    const { data: inside, error: e1 } = await supabase.rpc('point_in_event_geofence', {
      p_event_id: createdEventId, p_lat: 5.6037, p_lng: -0.1870,
    })
    step('point_in_event_geofence at center → true', !e1 && inside === true, e1?.message || `→ ${inside}`)
    const { data: outside, error: e2 } = await supabase.rpc('point_in_event_geofence', {
      p_event_id: createdEventId, p_lat: 5.7000, p_lng: -0.1870,
    })
    step('point_in_event_geofence 1km away → false', !e2 && outside === false, e2?.message || `→ ${outside}`)
  }

  // ─── 4. haversine sanity ───────────────────────────────────────────────
  {
    const { data, error } = await supabase.rpc('haversine_meters', {
      p_lat1: 5.6037, p_lng1: -0.1870, p_lat2: 5.6037, p_lng2: -0.1870,
    })
    step('haversine_meters same point → 0', !error && data === 0, error?.message || `→ ${data}`)
  }

  // ─── 5. record_pin_attempt: wrong PIN, then correct ───────────────────
  {
    const { data: wrong, error: e1 } = await supabase.rpc('record_pin_attempt', {
      p_event_id: createdEventId, p_member_id: memberId, p_pin_plain: '000000',
    })
    step('record_pin_attempt wrong PIN', !e1 && wrong?.ok === false && wrong?.reason === 'wrong_pin',
         e1?.message || JSON.stringify(wrong))
    const { data: ok, error: e2 } = await supabase.rpc('record_pin_attempt', {
      p_event_id: createdEventId, p_member_id: memberId, p_pin_plain: '123456',
    })
    step('record_pin_attempt correct PIN', !e2 && ok?.ok === true, e2?.message || JSON.stringify(ok))
  }

  // ─── 6. PIN lockout: 5 wrong attempts trigger 15-min lockout ───────────
  {
    let lockedOut = false
    for (let i = 0; i < 5; i++) {
      const { data } = await supabase.rpc('record_pin_attempt', {
        p_event_id: createdEventId, p_member_id: otherMemberId, p_pin_plain: '999999',
      })
      if (data?.reason === 'locked_out') lockedOut = true
    }
    step('5 wrong PINs → lockout', lockedOut)
  }

  // ─── 7. reset_event_pin clears lockout and changes PIN ────────────────
  {
    const { error: e1 } = await supabase.rpc('reset_event_pin', {
      p_event_id: createdEventId, p_pin_plain: '654321',
    })
    step('reset_event_pin', !e1, e1?.message || '')
    const { data, error: e2 } = await supabase.rpc('record_pin_attempt', {
      p_event_id: createdEventId, p_member_id: otherMemberId, p_pin_plain: '654321',
    })
    step('new PIN works after reset (lockout cleared)', !e2 && data?.ok === true,
         e2?.message || JSON.stringify(data))
  }

  // ─── 8. claim_device_for_event ────────────────────────────────────────
  {
    const { data: a, error: e1 } = await supabase.rpc('claim_device_for_event', {
      p_event_id: createdEventId, p_fingerprint: fingerprintA, p_member_id: memberId,
    })
    step('claim device A for member1 → true', !e1 && a === true, e1?.message || `→ ${a}`)
    const { data: b, error: e2 } = await supabase.rpc('claim_device_for_event', {
      p_event_id: createdEventId, p_fingerprint: fingerprintA, p_member_id: memberId,
    })
    step('re-claim device A for same member → true (idempotent)', !e2 && b === true, e2?.message || `→ ${b}`)
    const { data: c, error: e3 } = await supabase.rpc('claim_device_for_event', {
      p_event_id: createdEventId, p_fingerprint: fingerprintA, p_member_id: otherMemberId,
    })
    step('claim device A for OTHER member → false', !e3 && c === false, e3?.message || `→ ${c}`)
  }

  // ─── 9. insert a checkin_record + heartbeat checkout ──────────────────
  {
    const { error: e1 } = await supabase.from('checkin_records').insert({
      event_id: createdEventId, member_id: memberId, member_name: 'Smoke Tester',
      method: 'QR', geo_verified: true, device_fingerprint: fingerprintA,
      check_in_lat: 5.6037, check_in_lng: -0.1870,
    })
    step('insert checkin_record', !e1, e1?.message || '')

    const { data: inFence, error: e2 } = await supabase.rpc('report_member_location', {
      p_event_id: createdEventId, p_member_id: memberId, p_lat: 5.6037, p_lng: -0.1870,
    })
    step('heartbeat inside fence → no checkout', !e2 && inFence?.inside_fence === true && inFence?.checked_out === false,
         e2?.message || JSON.stringify(inFence))

    const { data: outFence, error: e3 } = await supabase.rpc('report_member_location', {
      p_event_id: createdEventId, p_member_id: memberId, p_lat: 5.7000, p_lng: -0.1870,
    })
    step('heartbeat outside fence → checkout fires', !e3 && outFence?.inside_fence === false && outFence?.checked_out === true,
         e3?.message || JSON.stringify(outFence))
  }

  // ─── 10. auto_checkout_expired_events (call but expect 0 since event is in future) ─
  {
    const { data, error } = await supabase.rpc('auto_checkout_expired_events')
    step('auto_checkout_expired_events callable', !error, error?.message || `→ closed=${data}`)
  }

  // ─── cleanup ──────────────────────────────────────────────────────────
  await supabase.from('checkin_events').delete().eq('id', createdEventId)
  await supabase.from('member_profiles').delete().in('id', [memberId, otherMemberId])
  console.log('\n→ cleanup complete')

  console.log(process.exitCode ? '\n✗ smoke test FAILED' : '\n✓ smoke test PASSED')
}

main().catch((err) => {
  console.error('\n✗ smoke test crashed:', err.message)
  process.exitCode = 1
})
