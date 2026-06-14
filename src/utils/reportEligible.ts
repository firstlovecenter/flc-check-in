/**
 * Resolve which members appear in dashboard stats / full report tabs.
 *
 * EventDashboard shows stats from viewerSlice for sub-scope leaders, but report
 * URLs carry ?level=&churchId= for their viewerScope. Filtering the full
 * eligible list by `${level}_id` often returns [] when snapshot rows lack
 * hierarchy columns — report looks blank while dashboard shows numbers.
 */

export function resolveReportEligible({
  allEligible,
  viewerSlice,
  viewerCaps,
  filterLevel = null,
  filterChurchId = null,
}: {
  allEligible: any[]
  viewerSlice: any[]
  viewerCaps: {
    canManage?: boolean
    canViewFullEvent?: boolean
    viewerScope?: { level: string; id: string; name?: string } | null
  } | null
  filterLevel?: string | null
  filterChurchId?: string | null
}): any[] {
  const canViewWholeEvent = !!(viewerCaps?.canManage || viewerCaps?.canViewFullEvent)
  const base = canViewWholeEvent
    ? allEligible
    : (viewerSlice.length > 0 ? viewerSlice : allEligible)

  if (!filterLevel || !filterChurchId || filterChurchId === '__all__') return base

  const vs = viewerCaps?.viewerScope
  // Leader stat-card links use viewerScope in the query string — same slice as dashboard.
  if (!canViewWholeEvent && vs?.level === filterLevel && vs?.id === filterChurchId) return base

  const idCol = `${filterLevel}_id`
  return base.filter((m) => m[idCol] === filterChurchId)
}
