import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpcMock = vi.fn()

vi.mock('./supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}))
vi.mock('./membersApi', () => ({
  childScopeLevel: () => null,
  getChildChurches: async () => [],
  getChurchAncestors: async () => [],
}))

import { submitCheckIn } from './supabaseCheckins'

const input = {
  eventId: 'evt-1',
  member: { id: 'm-1', name: 'Ama', role: 'bacenta', unitName: 'B1' },
  method: 'PIN',
  lat: 5.6, lng: -0.2,
  fingerprint: 'fp',
  pin: '123456',
}

beforeEach(() => {
  rpcMock.mockReset()
  vi.spyOn(Math, 'random').mockReturnValue(0)
})

describe('submitCheckIn', () => {
  it('retries once when the request never got an answer', async () => {
    rpcMock
      .mockResolvedValueOnce({ data: null, error: { message: 'TypeError: Failed to fetch' } })
      .mockResolvedValueOnce({ data: { ok: true, record: { id: 'r1' } }, error: null })

    await expect(submitCheckIn(input)).resolves.toEqual({ ok: true, record: { id: 'r1' } })
    expect(rpcMock).toHaveBeenCalledTimes(2)
    expect(rpcMock.mock.calls[0]).toEqual(rpcMock.mock.calls[1]) // identical, idempotent retry
  })

  it('does not retry a real server answer', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'permission denied for function submit_checkin' } })

    const result = await submitCheckIn(input)
    expect(result).toMatchObject({ ok: false, reason: 'rpc_error' })
    expect(rpcMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry a rejected check-in (wrong PIN is an answer, not a failure)', async () => {
    rpcMock.mockResolvedValueOnce({ data: { ok: false, reason: 'wrong_pin' }, error: null })

    await expect(submitCheckIn(input)).resolves.toEqual({ ok: false, reason: 'wrong_pin' })
    expect(rpcMock).toHaveBeenCalledTimes(1)
  })

  it('gives up after one retry', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'Failed to fetch' } })

    const result = await submitCheckIn(input)
    expect(result).toMatchObject({ ok: false, reason: 'rpc_error' })
    expect(rpcMock).toHaveBeenCalledTimes(2)
  })
})
