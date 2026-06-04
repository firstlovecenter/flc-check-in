import { describe, expect, it } from 'vitest'
import { resolveReportEligible } from './reportEligible'

const members = [
  { id: 'a', council_id: 'c1', governorship_id: 'g1' },
  { id: 'b', council_id: null, governorship_id: 'g1' },
]

describe('resolveReportEligible', () => {
  it('uses viewerSlice for non-admin without scope filter', () => {
    const slice = [{ id: 'b' }]
    expect(
      resolveReportEligible({
        allEligible: members,
        viewerSlice: slice,
        viewerCaps: { canManage: false, viewerScope: { level: 'council', id: 'c1' } },
      }),
    ).toEqual(slice)
  })

  it('uses viewerSlice when URL scope matches viewerScope (no column filter)', () => {
    const slice = [{ id: 'b', council_id: null }]
    expect(
      resolveReportEligible({
        allEligible: members,
        viewerSlice: slice,
        viewerCaps: { canManage: false, viewerScope: { level: 'council', id: 'c1' } },
        filterLevel: 'council',
        filterChurchId: 'c1',
      }),
    ).toEqual(slice)
  })

  it('filters admin eligible by scope column', () => {
    expect(
      resolveReportEligible({
        allEligible: members,
        viewerSlice: [],
        viewerCaps: { canManage: true },
        filterLevel: 'council',
        filterChurchId: 'c1',
      }),
    ).toEqual([members[0]])
  })
})
