# GitHub Copilot Instructions
# PVCIO Monitor — Colossians Stream

## Read PROJECT_CONTEXT.md first. Always.

---

## Stack
- React + Vite
- React Router v6 (4 screens — see flow below)
- Tailwind CSS (mobile-first)
- date-fns (formatting, time-ago)
- uuid (log entry IDs)
- localStorage (data layer — swappable to API)

## Key files
- `src/data/activities.js`  — all PVCIO activity definitions + field schemas
- `src/data/leaders.js`     — church structure (Stream > Council > Gov > Bacenta)
- `src/utils/auth.js`       — JWT decode, role→level, getCurrentUser(), loginWithCredentials()
- `src/utils/logs.js`       — getLogs(), addLog(), deleteLog(), buildSubmittedBy()

## Screen flow
```
LoginScreen → HomeScreen → ActivityPickerScreen → LogFormScreen → HomeScreen
```

## Routing
```jsx
<Routes>
  <Route path="/"           element={<LoginScreen />} />
  <Route path="/home"       element={<HomeScreen />} />
  <Route path="/pick/:cat"  element={<ActivityPickerScreen />} />
  <Route path="/log/:actId" element={<LogFormScreen />} />
</Routes>
```

## Levels (use these exact strings everywhere)
`'bacenta'` | `'governorship'` | `'oversight'`

## Key conventions
- `getCurrentUser()` — call this to get the logged-in user everywhere
- `getActivitiesForLevel(user.level)` — get activities for a user
- `getActivitiesByCategoryAndLevel(catId, user.level)` — for ActivityPickerScreen
- `addLog(userId, entry)` — to save a form submission
- `buildSubmittedBy(user)` — build the submittedBy block before calling addLog
- `getRecentLogs(userId, 20)` — for the home feed

## Field types to implement (src/components/fields/)
| type | Component | Behaviour |
|---|---|---|
| `attendance` | AttendanceField | Number input, min 0, large tap target |
| `names` | NamesField | Textarea, one name per line |
| `bacentas` | BacentaChecklistField | Checkbox list from leaders.js filtered by user's governorship id |
| `issueType` | IssueTypeField | Two large toggle buttons: "General" / "Critical" |
| `note` | NoteField | Textarea, always optional |
| `photo` | PhotoField | File input + camera capture. Store as base64 for now. TODO: swap to upload API |

## LogFormScreen behaviour
1. Read activityId from route param
2. Look up activity with `getActivityById(actId)`
3. Render each field in `activity.fields` using the matching component
4. On submit:
   - Validate required fields
   - Call `addLog(user.userId, { activityId, activityName, category, level, submittedBy: buildSubmittedBy(user), fields })`
   - Show success toast
   - Navigate to `/home`

## HomeScreen layout
```
TopBar (user name, unit, level badge, logout)
  ↓
Greeting card (Hi [firstName] · unit · date)
  ↓
CategoryGrid (5 cards, 2-col: 2+2+1)
  → tap → navigate to /pick/:catId
  ↓
"Recent Activity" heading
  ↓
RecentFeed (last 20 logs, newest first)
  - Each row: activity name · unit · time-ago
  - Tap to expand: shows field values
```

## Design tokens
```css
--bg:       #0C0F1A
--bg2:      #111520
--card:     #1A2040
--border:   #252D4A
--text:     #E8EBF8
--muted:    #6B7399
--accent:   #4F7FFF
--green:    #34D399
--amber:    #FBBF24
--coral:    #F87060
--teal:     #2DD4BF
--purple:   #A78BFA

Level badge colours:
  bacenta:     #7fa8ff (blue)
  governorship:#c4b5fd (purple)
  oversight:   #fcd34d (amber)
```

## Auth wiring note
`loginWithCredentials()` in auth.js is ready — just set VITE_AUTH_API_URL in .env.
The mock user is David Dag Vanderpuije (oversight + admin). Use during dev.
Do NOT hardcode credentials anywhere.

## What NOT to build yet
- Admin panel / dashboard (future phase)
- Backend API (everything is localStorage for now)
- Push notifications
- Multi-user feed (home feed shows only the logged-in user's own logs)
