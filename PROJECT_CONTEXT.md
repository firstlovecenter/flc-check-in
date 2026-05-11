# PVCIO Monitor — Full Project Context
## For GitHub Copilot / AI Assistants

---

## What This Is

A mobile-first React web app for church leaders to log their PVCIO activities
(Prayer, Visitation, Counseling, Interaction/Teaching, Outreaches).

Leaders log in via an existing JWT auth system. The app identifies who they are,
what level they operate at (Bacenta / Governorship / Oversight), and shows them
only the activities relevant to their level.

The core interaction is simple:
  Home → Pick category → Pick activity → Fill in details → Submit → Back to home

The home page shows a live feed of their recent submissions below the category picker.

---

## Church Hierarchy

```
Stream (Colossians)
  └── Oversight / Council  (same thing)
        └── Governorship
              └── Bacenta  (smallest unit)
```

---

## Auth System

**Existing external auth — do not build login/register logic from scratch.**

The app calls an existing API endpoint on login. The response returns a JWT.
Decode the JWT client-side to get user info. No signature verification needed in the UI.

### Login API call
```
POST https://[AUTH_API_URL]/login
Content-Type: application/json
{ "email": "...", "password": "..." }
```

### Response shape
```json
{
  "message": "Login successful",
  "tokens": { "accessToken": "<JWT>", "refreshToken": "<JWT>" },
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "firstName": "David Dag",
    "lastName": "Vanderpuije",
    "roles": ["leaderBacenta", "leaderOversight", "adminStream"]
  }
}
```

### JWT payload (decoded)
```json
{
  "userId": "uuid",
  "email": "...",
  "firstName": "David Dag",
  "lastName": "Vanderpuije",
  "roles": ["leaderBacenta", "leaderOversight", "adminStream"]
}
```

### Role → Level mapping
| JWT Role | Level |
|---|---|
| `leaderBacenta` | bacenta |
| `leaderGovernorship` | governorship |
| `leaderOversight` or `leaderCouncil` | oversight |
| `adminStream` | oversight + admin flag |

Use the highest level if a user has multiple roles.

### Mock user for development
```js
export const MOCK_USER = {
  userId: "7573ecf9-b445-40ce-ba24-5c8ed262bf82",
  email: "dabick14@gmail.com",
  firstName: "David Dag",
  lastName: "Vanderpuije",
  roles: ["leaderBacenta", "leaderOversight", "adminStream"],
  bacenta:     { id: "9e926ea4", name: "God Chasers" },
  governorship:{ id: "a9eda2d9", name: "Haatso Mabey" },
  council:     { name: "Colossians 1" },
  stream:      { id: "2dd77486", name: "Colossians" },
  level: "oversight",
  isAdmin: true,
};
```

---

## App Flow

```
[Login Screen]
     │
     ▼
[Home Screen]
  ┌─────────────────────────────────┐
  │  Hi David Dag 👋                 │
  │  God Chasers · Haatso Mabey     │
  │                                 │
  │  [🙏 Prayer]  [🏠 Visitation]   │
  │  [💬 Counsel] [📖 Teaching]     │
  │       [🌍 Outreaches]           │
  │                                 │
  │  ── Recent Activity ──          │
  │  ✓ Bacenta Prayer  Today 8am    │
  │  ✓ Dance Outreach  2 May        │
  └─────────────────────────────────┘
     │
     ▼ tap a category
[Activity Picker Screen]
  Lists all activities for user's level in that category
     │
     ▼ tap an activity
[Log Form Screen]
  Activity name at top
  Activity-specific fields (see ACTIVITIES.md)
  "Log Activity" button at bottom
     │
     ▼ on submit
  Save to localStorage → toast → navigate back to Home
  New entry appears at top of recent feed
```

---

## Tech Stack

- **React** (Vite)
- **React Router v6**
- **Tailwind CSS**
- **date-fns** (date formatting / time-ago)
- **localStorage** for all data (ready to swap to API later)
- No custom backend in this phase

---

## File Structure

```
src/
  data/
    activities.js       # All PVCIO activity definitions + field schemas
    leaders.js          # Church structure (from governors.json)
  utils/
    auth.js             # JWT decode, role→level, getCurrentUser()
    logs.js             # CRUD for log entries in localStorage
  screens/
    LoginScreen.jsx
    HomeScreen.jsx
    ActivityPickerScreen.jsx
    LogFormScreen.jsx
  components/
    TopBar.jsx
    CategoryGrid.jsx
    RecentFeed.jsx
    fields/
      AttendanceField.jsx
      NamesField.jsx
      PhotoField.jsx
      NoteField.jsx
      BacentaChecklistField.jsx
      IssueTypeField.jsx
  App.jsx
  main.jsx
```

---

## Log Entry Shape (localStorage)

Stored under key: `pvcio_logs_[userId]` as a JSON array.

```js
{
  id: "uuid-v4",
  activityId: "p1",
  activityName: "Bacenta Prayer Meeting",
  category: "prayer",
  level: "bacenta",
  submittedAt: "2026-05-06T08:32:00.000Z",
  submittedBy: {
    userId: "...",
    name: "David Dag Vanderpuije",
    level: "oversight",
    unitName: "God Chasers",
    governorship: "Haatso Mabey",
    council: "Colossians 1",
    stream: "Colossians",
  },
  fields: {
    // activity-specific key/value pairs — see ACTIVITIES.md
  }
}
```

### src/utils/logs.js exports
```js
getLogs(userId)           // returns array, newest first
addLog(userId, entry)     // prepends entry, saves
deleteLog(userId, logId)  // removes by id
exportLogs(userId)        // returns JSON string for future API sync
```

---

## UI Behaviours

1. **Category grid** — 5 cards, 2-column layout (2+2+1 or 3+2). Tap → ActivityPickerScreen.
2. **Activity picker** — flat list of activities for the user's level in that category.
3. **Log form** — activity name header, fields, big submit button. On submit: save, toast, back to Home.
4. **Recent feed** — last 20 logs, newest first. Shows: activity name, unit, time-ago. Tap to expand and see field values.
5. **Multiple logs of same activity** — fully supported. Each is a separate timestamped entry.
6. **No period selector** — timestamp is automatic. Backend handles aggregation later.
7. **Photo field** — store as base64 for now. Add a clear TODO comment to swap to file upload API.

---

## Design System

- Mobile-first, works on desktop
- Dark theme: bg #0C0F1A, cards #1A2040
- Fonts: Syne (headings), Instrument Sans (body), DM Mono (mono/labels)
- Accent: #4F7FFF
- Level colours: Bacenta #7fa8ff · Governorship #c4b5fd · Oversight #fcd34d
- Category colours defined in ACTIVITIES.md
- Smooth screen transitions (slide or fade)
- Subtle card press states (scale or opacity)
