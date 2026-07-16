# Hineni — routes and screens

Source: `src/App.tsx`. Lazy-loaded chunks except Login and Home.

## Public (no auth)

| Path | Screen | Notes |
|------|--------|-------|
| `/` | `LoginScreen` | Splash wrapper |
| `/forgot-password` | `ForgotPasswordScreen` | |
| `/reset-password` | `ResetPasswordScreen` | |
| `/events`, `/qr` | `QRDisplayScreen` | Public rotating QR / PIN display |

## Authenticated — all users

| Path | Screen | Notes |
|------|--------|-------|
| `/home` | `LeaderHomeScreen` | Event list; Create Event if admin |
| `/checkin/:eventId` | `CheckInFormScreen` | QR / PIN / Face tabs + geofence |
| `/app/events` | `EventHistoryScreen` | Unified Live / Upcoming / Past event browser |
| `/events/:eventId` | `EventDashboardScreen` | Live stats; role-adaptive |
| `/events/:eventId/edit` | `EventEditScreen` | Admin manage |
| `/events/:eventId/report` | `FullReportScreen` | Tabs: checked-in / defaulted / checked-out |
| `/events/:eventId/scopes` | `ScopeBreakdownScreen` | Child scope attendance |
| `/events/:eventId/audit` | `AuditLogScreen` | Admin audit trail |
| `/profile` | `ProfileScreen` | |

## Admin (`RequireAuth`; many also need `isAdmin` or caps)

| Path | Screen | Guard |
|------|--------|-------|
| `/admin/events/new` | `CreateEventScreen` | Auth; form uses `getAdminScopes` |
| `/admin/reports` | `ReportsScreen` | `RequireAdmin` |
| `/history`, `/admin/history` | Redirect | `/app/events?view=past` |
| `/admin/biometrics` | `MemberBiometricsScreen` | Auth |
| `/admin/members` | `MemberSearchScreen` | Auth |
| `/admin/members/:memberId` | `MemberDetailScreen` | Auth |
| `/admin/sync-members` | `SyncMembersScreen` | Superadmin sync |
| `/admin/groups` | `SpecialGroupsScreen` | Superadmin |

## Redirects

- `/admin/events/:eventId/*` → `/events/:eventId/*`
- Old report paths → `/events/:id/report?tab=…`

## Layout components

| Component | Used on |
|-----------|---------|
| `TopBar` | `LeaderHomeScreen` |
| `ScreenHeader` | Most drill-down screens |
| `NavDrawer` | Hamburger in TopBar / ScreenHeader |
| `PageShell` / `PageMain` | Authenticated page bodies |
| `AuthLayout` | Login / forgot / reset |

There is **no** portal `AppShell` or desktop sidebar in Hineni.
