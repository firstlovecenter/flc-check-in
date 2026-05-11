# PVCIO Monitor — Updated Activities & Calendar Context
## Replaces previous activities.js context. Read this alongside PROJECT_CONTEXT.md.

---

## Church Hierarchy (updated — 4 levels)

```
Bishop
  └── Overseer / Council  (same thing)
        └── Governorship
              └── Bacenta  (smallest unit)
```

Bishop is the level above Overseer. It maps to the Stream leader role in the JWT.

### Role → Level mapping (updated)
| JWT Role | Level |
|---|---|
| `leaderBacenta` | `bacenta` |
| `leaderGovernorship` | `governorship` |
| `leaderOversight` or `leaderCouncil` | `overseer` |
| `adminStream` or stream-level roles | `bishop` |

Use these exact level strings throughout the codebase:
`'bacenta'` | `'governorship'` | `'overseer'` | `'bishop'`

---

## The 6-Week Cycle

Activities are organised around a repeating 6-week cycle. Each week has a focus theme.
The app does NOT auto-calculate the cycle week. Leaders reference the printed calendar
themselves. The app uses standard ISO weeks (Monday–Sunday) for grouping logs.

### Cycle structure
| Week | Theme | Special activities that week |
|---|---|---|
| Week 1 | Prayer | All 4 once-per-cycle prayer events |
| Week 2 | Visitation | Bacenta Leaders' Visitation Saturday |
| Week 3 | Visitation | Governors' Visitation Saturday |
| Week 4 | Counseling/Interaction | Extended counseling sessions |
| Week 5 | Teaching | All joint services + Inter-Bacenta service |
| Week 6 | Outreaches | One outreach per level + cycle review |

### Current cycle dates (first cycle)
- Week 1: 11–17 May 2026
- Week 2: 18–24 May 2026
- Week 3: 25–31 May 2026
- Week 4: 1–7 Jun 2026
- Week 5: 8–14 Jun 2026
- Week 6: 15–21 Jun 2026

---

## Weekly Summary Prompt

At the end of every ISO week (Sunday), prompt the leader with a summary:
- How many activities they logged that week
- Which expected recurring activities were NOT logged
- A simple "How did your week go?" free-text field
- A nudge to plan the coming week

This is a soft prompt — not a blocker. Leader can dismiss it.

---

## Activity Definitions (replaces activities.js)

### RECURRING — Every week, all levels

These appear every week regardless of cycle theme.

```js
// Applies to: ALL levels
{
  id: 'rec1',
  category: 'counseling',
  freq: 'weekly',
  day: 'Tuesday',
  name: 'Telepastoring',
  desc: 'Every leader calls ≥5 members',
  appliesTo: ['bacenta', 'governorship', 'overseer', 'bishop'],
  fields: [
    { id: 'count',    type: 'attendance', label: 'How many members did you call?', required: true, min: 5, flagBelow: 5 },
    { id: 'note',     type: 'note',       label: 'Notes (optional)',               required: false },
  ],
},

// Applies to: governorship, overseer, bishop
{
  id: 'rec2',
  category: 'prayer',
  freq: 'weekly',
  day: 'Wednesday',
  name: 'Governorship Prayer Meeting',
  desc: 'Remind Bacenta leaders of Thursday prayer; address Sunday matters',
  appliesTo: ['governorship', 'overseer', 'bishop'],
  fields: [
    { id: 'attendance', type: 'attendance', label: 'How many attended?', required: true },
    { id: 'note',       type: 'note',       label: 'Notes (optional)',   required: false },
  ],
},

// Applies to: bacenta, governorship, overseer, bishop
{
  id: 'rec3',
  category: 'prayer',
  freq: 'weekly',
  day: 'Thursday',
  name: 'Bacenta Morning Prayer',
  desc: 'All members',
  appliesTo: ['bacenta', 'governorship', 'overseer', 'bishop'],
  fields: [
    { id: 'attendance', type: 'attendance', label: 'How many attended?', required: true },
    { id: 'note',       type: 'note',       label: 'Notes (optional)',   required: false },
    { id: 'photo',      type: 'photo',      label: 'Photo (optional)',   required: false },
  ],
},

// Applies to: overseer, bishop — leads Sunday morning prayer across all churches
{
  id: 'rec4',
  category: 'prayer',
  freq: 'weekly',
  day: 'Sunday',
  name: 'Sunday Morning Prayer (Lead)',
  desc: 'Overseers lead Sunday Morning Prayer — all churches, Governors & Bacentas',
  appliesTo: ['overseer', 'bishop'],
  fields: [
    { id: 'attendance', type: 'attendance', label: 'How many attended across all churches?', required: true },
    { id: 'note',       type: 'note',       label: 'Notes (optional)',                       required: false },
  ],
},

// Sunday post-church counseling — EACH LEVEL HAS ITS OWN MINIMUM TARGET
{
  id: 'rec5',
  category: 'counseling',
  freq: 'weekly',
  day: 'Sunday',
  name: 'Post-Church Counseling',
  desc: 'Governors: ≥3 members · Overseers: ≥3 Governors/Bacenta leaders · Bishop: ≥5',
  appliesTo: ['governorship', 'overseer', 'bishop'],
  // minimum target varies by level — enforce in UI
  minimumByLevel: { governorship: 3, overseer: 3, bishop: 5 },
  fields: [
    { id: 'count',  type: 'attendance', label: 'How many did you counsel?', required: true,
      // flag in UI if count < minimumByLevel[user.level]
      flagBelow: 'minimumByLevel' },
    { id: 'note',   type: 'note',       label: 'Notes (optional)',          required: false },
  ],
},
```

---

### ONCE-PER-CYCLE PRAYER — Week 1

```js
{
  id: 'sp1',
  category: 'prayer',
  freq: 'cycle',   // once per 6-week cycle
  cycleWeek: 1,
  day: 'Friday',
  name: 'Bacenta Half-Night Prayer',
  desc: 'In the community (once in 6 weeks)',
  appliesTo: ['bacenta', 'governorship', 'overseer', 'bishop'],
  fields: [
    { id: 'attendance', type: 'attendance', label: 'How many attended?', required: true },
    { id: 'note',       type: 'note',       label: 'Notes (optional)',   required: false },
    { id: 'photo',      type: 'photo',      label: 'Photo (optional)',   required: false },
  ],
},
{
  id: 'sp2',
  category: 'prayer',
  freq: 'cycle',
  cycleWeek: 1,
  day: 'Wednesday',
  name: 'Governorship Prayer Meeting — At the Centre',
  desc: 'Once in 6 weeks — replaces standard Wednesday meeting this week',
  appliesTo: ['governorship', 'overseer', 'bishop'],
  fields: [
    { id: 'attendance', type: 'attendance', label: 'How many attended?', required: true },
    { id: 'note',       type: 'note',       label: 'Notes (optional)',   required: false },
  ],
},
{
  id: 'sp3',
  category: 'prayer',
  freq: 'cycle',
  cycleWeek: 1,
  day: 'Thursday',
  name: 'Overseers Prayer Meeting',
  desc: 'At the centre or community (once in 6 weeks)',
  appliesTo: ['overseer', 'bishop'],
  fields: [
    { id: 'attendance', type: 'attendance', label: 'How many attended?', required: true },
    { id: 'note',       type: 'note',       label: 'Notes (optional)',   required: false },
  ],
},
{
  id: 'sp4',
  category: 'prayer',
  freq: 'cycle',
  cycleWeek: 1,
  day: 'Friday',
  name: 'Retreat in Mampong',
  desc: 'Minimum 7 hours (once in 6 weeks)',
  appliesTo: ['overseer', 'bishop'],
  fields: [
    { id: 'duration',   type: 'attendance', label: 'How many hours?',   required: true, min: 7, flagBelow: 7 },
    { id: 'attendance', type: 'attendance', label: 'How many attended?', required: true },
    { id: 'note',       type: 'note',       label: 'Notes / summary',   required: false },
    { id: 'photo',      type: 'photo',      label: 'Photo (optional)',   required: false },
  ],
},
```

---

### ONCE-PER-CYCLE VISITATION — Weeks 2 & 3

```js
{
  id: 'sv1',
  category: 'visitation',
  freq: 'cycle',
  cycleWeek: 2,
  day: 'Saturday',
  name: "Bacenta Leaders' Visitation Saturday",
  desc: 'Once in 6 weeks — Bacenta leaders visit their members',
  appliesTo: ['bacenta'],
  fields: [
    { id: 'visitedCount', type: 'attendance', label: 'How many members visited?',        required: true },
    { id: 'visitedNames', type: 'names',      label: 'Names visited (one per line)',      required: false },
    { id: 'concerns',     type: 'note',       label: 'Concerns or follow-ups?',           required: false },
    { id: 'photo',        type: 'photo',      label: 'Photo (optional)',                  required: false },
  ],
},
{
  id: 'sv2',
  category: 'visitation',
  freq: 'cycle',
  cycleWeek: 2,  // starts week 2, continues week 3
  day: 'Saturday',
  name: 'Overseers Visitation',
  desc: 'Visit Governors, Bacenta leaders, married couples & members with special circumstances (Weeks 2–3)',
  appliesTo: ['overseer', 'bishop'],
  fields: [
    { id: 'governorsVisited',  type: 'names',      label: 'Governors visited',              required: false },
    { id: 'leadersVisited',    type: 'names',      label: 'Bacenta leaders visited',        required: false },
    { id: 'couplesCount',      type: 'attendance', label: 'Married couples visited',        required: false },
    { id: 'specialCount',      type: 'attendance', label: 'Members with special circumstances visited', required: false },
    { id: 'concerns',          type: 'note',       label: 'Concerns or follow-ups?',        required: false },
  ],
},
{
  id: 'sv3',
  category: 'visitation',
  freq: 'cycle',
  cycleWeek: 3,
  day: 'Saturday',
  name: "Governors' Visitation Saturday",
  desc: 'Once in 6 weeks — Governors visit their bacenta leaders and members',
  appliesTo: ['governorship'],
  fields: [
    { id: 'visitedCount', type: 'attendance', label: 'How many visited?',             required: true },
    { id: 'visitedNames', type: 'names',      label: 'Names visited (one per line)',   required: false },
    { id: 'concerns',     type: 'note',       label: 'Concerns or follow-ups?',        required: false },
  ],
},
```

---

### ONCE-PER-CYCLE COUNSELING — Week 4

```js
{
  id: 'sc1',
  category: 'counseling',
  freq: 'cycle',
  cycleWeek: 4,
  day: 'Wednesday',
  name: 'Mid-Week Check-In',
  desc: 'Governors check in with members; Overseers with Governors/Bacenta leaders',
  appliesTo: ['governorship', 'overseer', 'bishop'],
  fields: [
    { id: 'count', type: 'attendance', label: 'How many did you check in with?', required: true },
    { id: 'note',  type: 'note',       label: 'Notes (optional)',                required: false },
  ],
},
{
  id: 'sc2',
  category: 'counseling',
  freq: 'cycle',
  cycleWeek: 4,
  day: 'Saturday',
  name: 'Extended Counseling Sessions',
  desc: 'Members with special circumstances, couples & follow-ups',
  appliesTo: ['governorship', 'overseer', 'bishop'],
  fields: [
    { id: 'sessionCount', type: 'attendance', label: 'How many sessions held?',                    required: true },
    { id: 'issueType',    type: 'issueType',  label: 'Issue type (general / critical)',             required: true },
    { id: 'note',         type: 'note',       label: 'Summary (keep brief, no sensitive details)',  required: false },
  ],
},
```

---

### ONCE-PER-CYCLE TEACHING — Week 5

```js
{
  id: 'st1',
  category: 'teaching',
  freq: 'cycle',
  cycleWeek: 5,
  day: 'Tuesday',
  name: 'Oversight SATs',
  desc: 'As and when scheduled — log when it happens',
  appliesTo: ['overseer', 'bishop'],
  fields: [
    { id: 'attendance', type: 'attendance', label: 'How many attended?', required: true },
    { id: 'note',       type: 'note',       label: 'Notes / summary',   required: false },
    { id: 'photo',      type: 'photo',      label: 'Photo (optional)',   required: false },
  ],
},
{
  id: 'st2',
  category: 'teaching',
  freq: 'cycle',
  cycleWeek: 5,
  day: 'Thursday',
  name: 'Inter-Bacenta Service',
  desc: 'Once in 6 weeks',
  appliesTo: ['bacenta', 'governorship'],
  fields: [
    { id: 'attendance',    type: 'attendance', label: 'How many attended?',              required: true },
    { id: 'bacentasJoined',type: 'names',      label: 'Which bacentas joined?',          required: false },
    { id: 'note',          type: 'note',       label: 'Notes (optional)',                required: false },
    { id: 'photo',         type: 'photo',      label: 'Photo (optional)',                required: false },
  ],
},
{
  id: 'st3',
  category: 'teaching',
  freq: 'cycle',
  cycleWeek: 5,
  day: 'Saturday',
  name: 'Council Joint Service with Overseer',
  desc: 'Once in 6 weeks',
  appliesTo: ['overseer', 'bishop'],
  fields: [
    { id: 'attendance', type: 'attendance', label: 'How many attended?', required: true },
    { id: 'note',       type: 'note',       label: 'Notes / summary',   required: false },
    { id: 'photo',      type: 'photo',      label: 'Photo (optional)',   required: false },
  ],
},
{
  id: 'st4',
  category: 'teaching',
  freq: 'cycle',
  cycleWeek: 5,
  day: 'Saturday',
  name: 'Governorship Joint Service',
  desc: 'Once in 6 weeks',
  appliesTo: ['governorship', 'overseer', 'bishop'],
  fields: [
    { id: 'attendance', type: 'attendance', label: 'How many attended?', required: true },
    { id: 'note',       type: 'note',       label: 'Notes (optional)',   required: false },
    { id: 'photo',      type: 'photo',      label: 'Photo (optional)',   required: false },
  ],
},
{
  id: 'st5',
  category: 'teaching',
  freq: 'cycle',
  cycleWeek: 5,
  day: 'Sunday',
  name: 'Inter-Overseer Service',
  desc: 'Once in 6 weeks',
  appliesTo: ['overseer', 'bishop'],
  fields: [
    { id: 'attendance', type: 'attendance', label: 'How many attended?', required: true },
    { id: 'note',       type: 'note',       label: 'Notes / summary',   required: false },
    { id: 'photo',      type: 'photo',      label: 'Photo (optional)',   required: false },
  ],
},
```

---

### ONCE-PER-CYCLE OUTREACHES — Week 6

Each level does ONE outreach chosen from: dance outreach / breakfast meeting /
movie or games night.

```js
{
  id: 'so1',
  category: 'outreaches',
  freq: 'cycle',
  cycleWeek: 6,
  day: 'Saturday',
  name: 'Bacenta Level Outreach',
  desc: 'Choose one: dance outreach / breakfast meeting / movie or games night',
  appliesTo: ['bacenta'],
  fields: [
    { id: 'outreachType', type: 'select',     label: 'Which outreach?',
      options: ['Dance Outreach', 'Breakfast Meeting', 'Movie Night', 'Games Night'],
      required: true },
    { id: 'attendance',   type: 'attendance', label: 'How many attended?',         required: true },
    { id: 'salvations',   type: 'attendance', label: 'Salvations / first-timers?', required: false },
    { id: 'note',         type: 'note',       label: 'Notes (optional)',           required: false },
    { id: 'photo',        type: 'photo',      label: 'Photo (optional)',           required: false },
  ],
},
{
  id: 'so2',
  category: 'outreaches',
  freq: 'cycle',
  cycleWeek: 6,
  day: 'Saturday',
  name: 'Governorship Level Outreach',
  desc: 'Choose one: dance outreach / breakfast meeting / movie or games night',
  appliesTo: ['governorship'],
  fields: [
    { id: 'outreachType', type: 'select',     label: 'Which outreach?',
      options: ['Dance Outreach', 'Breakfast Meeting', 'Movie Night', 'Games Night'],
      required: true },
    { id: 'attendance',   type: 'attendance', label: 'How many attended?',         required: true },
    { id: 'salvations',   type: 'attendance', label: 'Salvations / first-timers?', required: false },
    { id: 'note',         type: 'note',       label: 'Notes (optional)',           required: false },
    { id: 'photo',        type: 'photo',      label: 'Photo (optional)',           required: false },
  ],
},
{
  id: 'so3',
  category: 'outreaches',
  freq: 'cycle',
  cycleWeek: 6,
  day: 'Saturday',
  name: 'Oversight Level Outreach',
  desc: 'Choose one: dance outreach / breakfast meeting / movie or games night',
  appliesTo: ['overseer', 'bishop'],
  fields: [
    { id: 'outreachType', type: 'select',     label: 'Which outreach?',
      options: ['Dance Outreach', 'Breakfast Meeting', 'Movie Night', 'Games Night'],
      required: true },
    { id: 'attendance',   type: 'attendance', label: 'How many attended?',         required: true },
    { id: 'salvations',   type: 'attendance', label: 'Salvations / first-timers?', required: false },
    { id: 'note',         type: 'note',       label: 'Notes (optional)',           required: false },
    { id: 'photo',        type: 'photo',      label: 'Photo (optional)',           required: false },
  ],
},
```

---

## Field Types Reference (updated)

| type | Component | Behaviour |
|---|---|---|
| `attendance` | AttendanceField | Number input, large +/− buttons, min 0. If `flagBelow` set, highlight red when under threshold |
| `names` | NamesField | Textarea, one name per line |
| `select` | SelectField | Large tap-target option buttons (not a dropdown) |
| `issueType` | IssueTypeField | Two large toggle buttons: "General" / "Critical" |
| `note` | NoteField | Textarea, always optional |
| `photo` | PhotoField | Camera capture + gallery upload. Base64 for now — TODO: swap to Supabase Storage |

---

## Weekly Summary Prompt (new)

At the end of every ISO week (Sunday evening), show a summary screen:

```
┌─────────────────────────────────────────┐
│  Week of 11–17 May · Your Summary       │
│                                         │
│  ✓ 4 activities logged                  │
│  ✗ Telepastoring — not logged           │
│  ✗ Bacenta Morning Prayer — not logged  │
│                                         │
│  How did your week go?                  │
│  [________________________]             │
│                                         │
│  [Done]           [Remind me later]     │
└─────────────────────────────────────────┘
```

- Triggered automatically when app is opened on a Sunday or the following Monday
  and the previous week has no summary logged
- "Not logged" items = recurring activities expected for that level that have 0
  logs in that ISO week
- Free-text "how did your week go?" stored as a weekly_summary log entry
- Dismissible — leader can skip

### Weekly summary log entry shape (add to Supabase table)
```js
{
  type: 'weekly_summary',
  isoWeek: '2026-W20',         // ISO week string
  logsThisWeek: 4,
  missedActivities: ['rec1', 'rec3'],
  note: 'Good week overall...',
  submittedAt: '...',
  submittedBy: { ... }
}
```

---

## Updated Copilot Instructions Delta

Changes from previous context:

1. **4 levels** — add `'bishop'` above `'overseer'`. Update all level checks.
2. **`appliesTo` array** — activities now use `appliesTo: ['bacenta', ...]` instead
   of a single `level` field. Filter with `activity.appliesTo.includes(user.level)`.
3. **`freq: 'cycle'`** — new frequency type for once-per-6-week activities.
   Show these in the app under a "This cycle" section, separate from weekly/monthly.
4. **`flagBelow`** — attendance fields with `flagBelow` set should show a warning
   colour if the submitted count is below the threshold.
5. **`select` field type** — new. Render as large tap-target buttons, not a dropdown.
6. **Weekly summary prompt** — new screen/modal. Trigger on Sunday/Monday if
   previous week has no summary. Store as `weekly_summary` type in logs table.
7. **Supabase `activity_logs` table** — add a `type` column (`'activity' | 'weekly_summary'`)
   and an `iso_week` column (`text`, e.g. `'2026-W20'`) to all log entries.
