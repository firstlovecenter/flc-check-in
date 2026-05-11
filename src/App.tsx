import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom'
import LoginScreen from './screens/LoginScreen'
import LeaderHomeScreen from './screens/LeaderHomeScreen'
import QRDisplayScreen from './screens/QRDisplayScreen'
import CheckInFormScreen from './screens/CheckInFormScreen'
import EventDashboardScreen from './screens/admin/EventDashboardScreen'
import EventEditScreen from './screens/admin/EventEditScreen'
import FullReportScreen from './screens/admin/FullReportScreen'
import ScopeBreakdownScreen from './screens/admin/ScopeBreakdownScreen'
import CreateEventScreen from './screens/admin/CreateEventScreen'
import ReportsScreen from './screens/admin/ReportsScreen'
import EventHistoryScreen from './screens/admin/EventHistoryScreen'
import RequireAuth from './components/RequireAuth'
import ForgotPasswordScreen from './screens/ForgotPasswordScreen'
import ResetPasswordScreen from './screens/ResetPasswordScreen'
import ProfileScreen from './screens/ProfileScreen'

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
      <Routes>
        <Route path='/' element={<LoginScreen />} />
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

        {/* Old /admin/events/:id/* URLs redirect to /events/:id/* */}
        <Route path='/admin/events/:eventId' element={<RedirectAdminEvent />} />
        <Route path='/admin/events/:eventId/checked-in' element={<RedirectAdminEvent tail='/report?tab=checked-in' />} />
        <Route path='/admin/events/:eventId/defaulted' element={<RedirectAdminEvent tail='/report?tab=defaulted' />} />
        <Route path='/admin/events/:eventId/scopes' element={<RedirectAdminEvent tail='/scopes' />} />

        <Route path='*' element={<Navigate to='/' replace />} />
      </Routes>
    </BrowserRouter>
  )
}
