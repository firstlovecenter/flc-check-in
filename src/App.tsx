import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom'
import LoginScreen from './screens/LoginScreen'
import LeaderHomeScreen from './screens/LeaderHomeScreen'
import RequireAuth from './components/RequireAuth'
import SplashScreen from './components/SplashScreen'
import UpdatePrompt from './components/UpdatePrompt'
import Spinner from './components/Spinner'
import { ChurchFocusProvider } from './contexts/ChurchFocusContext'
import OfflineBanner from './components/OfflineBanner'
import { ToastHost } from './components/Toast'
import { getCurrentUser } from './utils/auth'

// Lazy-load route screens so vendor chunks (leaflet, zxing, qrcode,
// papaparse) only download when the user actually navigates to a screen that
// needs them. Login + Home stay eager because they're on the cold-load path.
const QRDisplayScreen        = lazy(() => import('./screens/QRDisplayScreen'))
const CheckInFormScreen      = lazy(() => import('./screens/CheckInFormScreen'))
const EventDashboardScreen   = lazy(() => import('./screens/admin/EventDashboardScreen'))
const EventEditScreen        = lazy(() => import('./screens/admin/EventEditScreen'))
const EventMembersScreen     = lazy(() => import('./screens/admin/EventMembersScreen'))
const ScopeBreakdownScreen   = lazy(() => import('./screens/admin/ScopeBreakdownScreen'))
const AuditLogScreen         = lazy(() => import('./screens/admin/AuditLogScreen'))
const CreateEventScreen      = lazy(() => import('./screens/admin/CreateEventScreen'))
const ReportsScreen          = lazy(() => import('./screens/admin/ReportsScreen'))
const EventHistoryScreen     = lazy(() => import('./screens/admin/EventHistoryScreen'))
const MemberDetailScreen     = lazy(() => import('./screens/admin/MemberDetailScreen'))
const SyncMembersScreen      = lazy(() => import('./screens/admin/SyncMembersScreen'))
const MemberSearchScreen     = lazy(() => import('./screens/admin/MemberSearchScreen'))
const SpecialGroupsScreen    = lazy(() => import('./screens/admin/SpecialGroupsScreen'))
const ForgotPasswordScreen   = lazy(() => import('./screens/ForgotPasswordScreen'))
const ResetPasswordScreen    = lazy(() => import('./screens/ResetPasswordScreen'))
const ProfileScreen          = lazy(() => import('./screens/ProfileScreen'))

// Minimal fallback shown while a route chunk loads. Kept identical to the
// app background so there's no visible flash between chunks.
function RouteFallback() {
  return <Spinner fullPage />
}

// Backwards-compat redirect: /events/:id/checked-in → /events/:id/members?status=present
function RedirectToMembersStatus({ status }: { status: string }) {
  const { eventId } = useParams()
  return <Navigate to={`/events/${eventId}/members?status=${status}`} replace />
}

// Backwards-compat redirect: /admin/events/:id/* → /events/:id/*
function RedirectAdminEvent({ tail = '' }) {
  const { eventId } = useParams()
  return <Navigate to={`/events/${eventId}${tail}`} replace />
}

function RedirectLegacyAdminHistory() {
  return <Navigate to='/app/events?view=past' replace />
}

function UnknownRouteRedirect() {
  return <Navigate to={getCurrentUser() ? '/home' : '/'} replace />
}

export default function App() {
  return (
    <BrowserRouter>
      <ChurchFocusProvider>
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
        <Route path='/events/:eventId/members' element={<RequireAuth><EventMembersScreen /></RequireAuth>} />
        {/* Legacy /report URL → all-members list */}
        <Route path='/events/:eventId/report' element={<RedirectToMembersStatus status='all' />} />
        <Route path='/events/:eventId/scopes' element={<RequireAuth><ScopeBreakdownScreen /></RequireAuth>} />
        <Route path='/events/:eventId/audit'  element={<RequireAuth><AuditLogScreen /></RequireAuth>} />

        {/* Old drilldown URLs → member list by status */}
        <Route path='/events/:eventId/checked-in'  element={<RedirectToMembersStatus status='present' />} />
        <Route path='/events/:eventId/defaulted'   element={<RedirectToMembersStatus status='absent' />} />
        <Route path='/events/:eventId/checked-out' element={<RedirectToMembersStatus status='present' />} />

        {/* Profile */}
        <Route path='/profile' element={<RequireAuth><ProfileScreen /></RequireAuth>} />

        {/* Admin-only */}
        <Route path='/admin/events/new' element={<RequireAuth><CreateEventScreen /></RequireAuth>} />
        <Route path='/admin/reports' element={<RequireAuth><ReportsScreen /></RequireAuth>} />
        <Route path='/app/events' element={<RequireAuth><EventHistoryScreen /></RequireAuth>} />
        <Route path='/history' element={<Navigate to='/app/events?view=past' replace />} />
        <Route path='/admin/history' element={<RedirectLegacyAdminHistory />} />
        <Route path='/admin/members' element={<RequireAuth><MemberSearchScreen /></RequireAuth>} />
        <Route path='/admin/members/:memberId' element={<RequireAuth><MemberDetailScreen /></RequireAuth>} />
        <Route path='/admin/sync-members' element={<RequireAuth><SyncMembersScreen /></RequireAuth>} />
        <Route path='/admin/groups' element={<RequireAuth><SpecialGroupsScreen /></RequireAuth>} />

        {/* Old /admin/events/:id/* URLs redirect to /events/:id/* */}
        <Route path='/admin/events/:eventId' element={<RedirectAdminEvent />} />
        <Route path='/admin/events/:eventId/checked-in' element={<RedirectAdminEvent tail='/members?status=present' />} />
        <Route path='/admin/events/:eventId/defaulted' element={<RedirectAdminEvent tail='/members?status=absent' />} />
        <Route path='/admin/events/:eventId/scopes' element={<RedirectAdminEvent tail='/scopes' />} />

        <Route path='*' element={<UnknownRouteRedirect />} />
      </Routes>
      </Suspense>
      </ChurchFocusProvider>
      <UpdatePrompt />
      <OfflineBanner />
      <ToastHost />
    </BrowserRouter>
  )
}
