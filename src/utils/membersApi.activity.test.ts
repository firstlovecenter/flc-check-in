import { describe, expect, it } from 'vitest'
import { memberToProfileRow } from './membersApi'

describe('Graph member operational eligibility', () => {
  it('marks members without current leader/admin relationships inactive', () => {
    const base = { id: 'member-1', leadsBacenta: [] }
    expect(memberToProfileRow(base).is_active).toBe(false)
    expect(memberToProfileRow({ ...base, leadsBacenta: [{ id: 'bacenta-1' }] }).is_active).toBe(true)
  })
})
