import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom'
import LoginScreen from './screens/LoginScreen'
import LeaderHomeScreen from './screens/LeaderHomeScreen'
import RequireAuth from './components/RequireAuth'
import SplashScreen from './components/SplashScreen'
import UpdatePrompt from './components/UpdatePrompt'

// Lazy-load route screens so vendor chunks (leaflet, face-api, zxing, qrcode,
// papaparse) only download when the user actually navigates to a screen that
// needs them. Login + Home stay eager because they're on the cold-load path.
const QRDisplayScreen        = lazy(() => import('./screens/QRDisplayScreen'))
const CheckInFormScreen      = lazy(() => import('./screens/CheckInFormScreen'))
const EventDashboardScreen   = lazy(() => import('./screens/admin/EventDashboardScreen'))
const EventEditScreen        = lazy(() => import('./screens/admin/EventEditScreen'))
const FullReportScreen       = lazy(() => import('./screens/admin/FullReportScreen'))
const ScopeBreakdownScreen   = lazy(() => import('./screens/admin/ScopeBreakdownScreen'))
const AuditLogScreen         = lazy(() => import('./screens/admin/AuditLogScreen'))
const CreateEventScreen      = lazy(() => import('./screens/admin/CreateEventScreen'))
const ReportsScreen          = lazy(() => import('./screens/admin/ReportsScreen'))
const EventHistoryScreen     = lazy(() => import('./screens/admin/EventHistoryScreen'))
const MemberBiometricsScreen = lazy(() => import('./screens/admin/MemberBiometricsScreen'))
const MemberDetailScreen     = lazy(() => import('./screens/admin/MemberDetailScreen'))
const SyncMembersScreen      = lazy(() => import('./screens/admin/SyncMembersScreen'))
const MemberSearchScreen     = lazy(() => import('./screens/admin/MemberSearchScreen'))
const ForgotPasswordScreen   = lazy(() => import('./screens/ForgotPasswordScreen'))
const ResetPasswordScreen    = lazy(() => import('./screens/ResetPasswordScreen'))
const ProfileScreen          = lazy(() => import('./screens/ProfileScreen'))

// Minimal fallback shown while a route chunk loads. Kept identical to the
// app background so there's no visible flash between chunks.
function RouteFallback() {
  return (
    <div
      className='min-h-dvh flex items-center justify-center'
      style={{ background: 'var(--bg)' }}
    >
      <p className='text-sm' style={{ color: 'var(--muted)' }}>Loading…</p>
    </div>
  )
}

// Backwards-compat redirect: /events/:id/checked-in → /events/:id/report?tab=checked-in
function RedirectToReportTab({ tab }) {
  const { eventId } = useParams()
  return <Navigate to={`/events/${eventId}/report?tab=${tab}`} replace />
}

// Backwards-compat redirect: /admin/events/:id/* → /events/:id/*
function RedirectAdminEvent({ tail = '' }) {
  const { eventId } = useParams()
  return <Navigate to={`/events/${eventId}${tail}`} replace />
}

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path='/' element={<SplashScreen><LoginScreen /></SplashScreen>} />
        <Route path='/forgot-password' element={<ForgotPasswordScreen />} />
        <Route path='/reset-password' element={<ResetPasswordScreen />} />

        {/* Leader-facing */}
        <Route path='/home' element={<RequireAuth><LeaderHomeScreen /></RequireAuth>} />
        <Route path='/events' element={<QRDisplayScreen />} />
        <Route path='/qr' element={<Navigate to='/events' replace />} />
        <Route path='/checkin/:eventId' element={<RequireAuth><CheckInFormScreen /></RequireAuth>} />

        {/* Universal event views — dashboard + report adapt to the viewer */}
        <Route path='/events/:eventId' element={<RequireAuth><EventDashboardScreen /></RequireAuth>} />
        <Route path='/events/:eventId/edit' element={<RequireAuth><EventEditScreen /></RequireAuth>} />
        <Route path='/events/:eventId/report' element={<RequireAuth><FullReportScreen /></RequireAuth>} />
        <Route path='/events/:eventId/scopes' element={<RequireAuth><ScopeBreakdownScreen /></RequireAuth>} />
        <Route path='/events/:eventId/audit'  element={<RequireAuth><AuditLogScreen /></RequireAuth>} />

        {/* Old drilldown URLs → report tabs */}
        <Route path='/events/:eventId/checked-in'  element={<RedirectToReportTab tab='checked-in' />} />
        <Route path='/events/:eventId/defaulted'   element={<RedirectToReportTab tab='defaulted' />} />
        <Route path='/events/:eventId/checked-out' element={<RedirectToReportTab tab='checked-out' />} />

        {/* Profile */}
        <Route path='/profile' element={<RequireAuth><ProfileScreen /></RequireAuth>} />

        {/* Admin-only */}
        <Route path='/admin/events/new' element={<RequireAuth><CreateEventScreen /></RequireAuth>} />
        <Route path='/admin/reports' element={<RequireAuth><ReportsScreen /></RequireAuth>} />
        <Route path='/admin/history' element={<RequireAuth><EventHistoryScreen /></RequireAuth>} />
        <Route path='/admin/biometrics' element={<RequireAuth><MemberBiometricsScreen /></RequireAuth>} />
        <Route path='/admin/members' element={<RequireAuth><MemberSearchScreen /></RequireAuth>} />
        <Route path='/admin/members/:memberId' element={<RequireAuth><MemberDetailScreen /></RequireAuth>} />
        <Route path='/admin/sync-members' element={<RequireAuth><SyncMembersScreen /></RequireAuth>} />

        {/* Old /admin/events/:id/* URLs redirect to /events/:id/* */}
        <Route path='/admin/events/:eventId' element={<RedirectAdminEvent />} />
        <Route path='/admin/events/:eventId/checked-in' element={<RedirectAdminEvent tail='/report?tab=checked-in' />} />
        <Route path='/admin/events/:eventId/defaulted' element={<RedirectAdminEvent tail='/report?tab=defaulted' />} />
        <Route path='/admin/events/:eventId/scopes' element={<RedirectAdminEvent tail='/scopes' />} />

        <Route path='*' element={<Navigate to='/' replace />} />
      </Routes>
      </Suspense>
      <UpdatePrompt />
    </BrowserRouter>
  )
}
