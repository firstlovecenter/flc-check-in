# Supabase Backend — PVCIO Monitor
## Context file for GitHub Copilot / AI Assistants

---

## Overview

This file defines the full Supabase backend for the PVCIO Monitor app.
It covers: database schema, Row Level Security (RLS) policies, storage buckets,
and the client-side integration pattern.

Supabase is used for:
- Storing all activity log entries (replacing localStorage)
- Storing uploaded photos (Supabase Storage)
- User profile/unit data (linked to existing JWT auth)

Supabase does NOT handle authentication — the existing external JWT auth system
handles login. Supabase receives the userId from that JWT and uses it for RLS.

---

## Environment Variables

Add these to your `.env` file:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_AUTH_API_URL=https://your-auth-api-url
```

---

## Supabase Client Setup

### src/utils/supabase.js

```js
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)
```

### Passing the external JWT to Supabase

Since auth is handled externally, pass the accessToken to Supabase so RLS
can identify the user. Do this after login:

```js
import { supabase } from './supabase'

export async function setSupabaseAuth(accessToken) {
  const { error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: '',   // not used — external auth handles refresh
  })
  if (error) console.error('Supabase auth error:', error)
}
```

Call `setSupabaseAuth(accessToken)` immediately after a successful login,
before making any database calls.

> NOTE: For RLS to work with an external JWT, the JWT must be signed with the
> same secret configured in Supabase under Settings > API > JWT Secret.
> Coordinate with the auth system owner to ensure this matches.
> Alternative: disable RLS and enforce access rules in your API layer instead.

---

## Database Schema

Run this SQL in the Supabase SQL editor to create all tables.

```sql
-- ─────────────────────────────────────────────────────────────
-- TABLE: profiles
-- Stores leader profile data derived from the JWT.
-- Created/updated on first login.
-- ─────────────────────────────────────────────────────────────
create table public.profiles (
  id              uuid primary key,           -- matches userId from JWT
  email           text not null,
  first_name      text not null,
  last_name       text not null,
  level           text not null               -- 'bacenta' | 'governorship' | 'oversight'
                  check (level in ('bacenta', 'governorship', 'oversight')),
  roles           text[] not null default '{}',
  bacenta_id      text,
  bacenta_name    text,
  governorship_id text,
  governorship_name text,
  council_name    text,
  stream_id       text,
  stream_name     text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ─────────────────────────────────────────────────────────────
-- TABLE: activity_logs
-- One row per activity submission.
-- ─────────────────────────────────────────────────────────────
create table public.activity_logs (
  id              uuid primary key default gen_random_uuid(),

  -- Activity metadata
  activity_id     text not null,              -- e.g. 'p1', 'o7' — matches activities.js
  activity_name   text not null,              -- e.g. 'Bacenta Prayer Meeting'
  category        text not null               -- 'prayer' | 'visitation' | 'counseling' | 'teaching' | 'outreaches'
                  check (category in ('prayer', 'visitation', 'counseling', 'teaching', 'outreaches')),
  level           text not null               -- 'bacenta' | 'governorship' | 'oversight'
                  check (level in ('bacenta', 'governorship', 'oversight')),
  freq            text not null               -- 'weekly' | 'monthly' | 'flexible'
                  check (freq in ('weekly', 'monthly', 'flexible')),

  -- Who submitted
  submitted_by_id   uuid not null references public.profiles(id),
  submitted_by_name text not null,            -- denormalised for easy display
  unit_name         text,                     -- bacenta/gov/council name at time of submission
  governorship_name text,
  council_name      text,
  stream_name       text,

  -- Form fields (flexible JSON — structure varies by activity)
  fields          jsonb not null default '{}',
  -- Examples:
  --   Prayer:     { "attendance": 12, "note": "Good turnout" }
  --   Visitation: { "visitedCount": 8, "visitedNames": ["Ama", "Kojo"], "concerns": "..." }
  --   Counseling: { "issueType": "General", "counseledCount": 3, "note": "..." }
  --   Teaching:   { "bacentasPreached": ["God Chasers", "Victory"], "note": "..." }
  --   Outreach:   { "attendance": 45, "salvations": 3, "note": "...", "photoUrl": "..." }

  -- Photo (optional)
  photo_url       text,                       -- Supabase Storage URL if photo uploaded

  -- Timestamps
  submitted_at    timestamptz default now(),
  created_at      timestamptz default now()
);

-- Index for fast per-user queries (home feed)
create index activity_logs_user_idx
  on public.activity_logs (submitted_by_id, submitted_at desc);

-- Index for oversight/admin queries (filter by level, category, date)
create index activity_logs_level_cat_idx
  on public.activity_logs (level, category, submitted_at desc);

-- Index for filtering by governorship (for governor's view)
create index activity_logs_gov_idx
  on public.activity_logs (governorship_name, submitted_at desc);
```

---

## Row Level Security (RLS)

```sql
-- Enable RLS on both tables
alter table public.profiles       enable row level security;
alter table public.activity_logs  enable row level security;

-- ── profiles ─────────────────────────────────────────────────
-- Users can read and update only their own profile
create policy "Users can read own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can upsert own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- ── activity_logs ─────────────────────────────────────────────
-- Users can insert their own logs
create policy "Users can insert own logs"
  on public.activity_logs for insert
  with check (auth.uid() = submitted_by_id);

-- Users can read their own logs
create policy "Users can read own logs"
  on public.activity_logs for select
  using (auth.uid() = submitted_by_id);

-- Users can delete their own logs
create policy "Users can delete own logs"
  on public.activity_logs for delete
  using (auth.uid() = submitted_by_id);

-- Admins (adminStream role) can read ALL logs
-- NOTE: implement this via a Supabase Edge Function or service role key
-- on the admin dashboard — do not expose service role key to the client.
```

---

## Storage Bucket

Create a bucket called `activity-photos` in Supabase Storage.

```sql
-- Run in SQL editor
insert into storage.buckets (id, name, public)
values ('activity-photos', 'activity-photos', false);

-- RLS: users can upload to their own folder
create policy "Users can upload own photos"
  on storage.objects for insert
  with check (
    bucket_id = 'activity-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- RLS: users can read their own photos
create policy "Users can read own photos"
  on storage.objects for select
  using (
    bucket_id = 'activity-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
```

Photo path convention: `{userId}/{logId}.jpg`

---

## Updated src/utils/logs.js (Supabase version)

Replace the localStorage version with this.

```js
import { supabase } from './supabase'

// ── Read ────────────────────────────────────────────────────────

export async function getLogs(userId, limit = 20) {
  const { data, error } = await supabase
    .from('activity_logs')
    .select('*')
    .eq('submitted_by_id', userId)
    .order('submitted_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data
}

export async function getLogsByCategory(userId, categoryId) {
  const { data, error } = await supabase
    .from('activity_logs')
    .select('*')
    .eq('submitted_by_id', userId)
    .eq('category', categoryId)
    .order('submitted_at', { ascending: false })
  if (error) throw error
  return data
}

// ── Write ───────────────────────────────────────────────────────

export async function addLog(user, entry, photoFile = null) {
  let photoUrl = null

  // Upload photo first if provided
  if (photoFile) {
    photoUrl = await uploadPhoto(user.userId, photoFile)
  }

  const row = {
    activity_id:       entry.activityId,
    activity_name:     entry.activityName,
    category:          entry.category,
    level:             entry.level,
    freq:              entry.freq,
    submitted_by_id:   user.userId,
    submitted_by_name: `${user.firstName} ${user.lastName}`,
    unit_name:         user.unitName,
    governorship_name: user.governorship?.name || null,
    council_name:      user.council?.name       || null,
    stream_name:       user.stream?.name        || null,
    fields:            entry.fields,
    photo_url:         photoUrl,
  }

  const { data, error } = await supabase
    .from('activity_logs')
    .insert(row)
    .select()
    .single()

  if (error) throw error
  return data
}

export async function deleteLog(logId) {
  const { error } = await supabase
    .from('activity_logs')
    .delete()
    .eq('id', logId)
  if (error) throw error
}

// ── Photos ──────────────────────────────────────────────────────

export async function uploadPhoto(userId, file) {
  const ext      = file.name.split('.').pop()
  const filename = `${userId}/${Date.now()}.${ext}`

  const { error: uploadError } = await supabase.storage
    .from('activity-photos')
    .upload(filename, file, { upsert: false })

  if (uploadError) throw uploadError

  const { data } = supabase.storage
    .from('activity-photos')
    .getPublicUrl(filename)

  return data.publicUrl
}

// ── Profile upsert ───────────────────────────────────────────────
// Call this on every login to keep profile in sync with JWT data

export async function upsertProfile(user) {
  const { error } = await supabase
    .from('profiles')
    .upsert({
      id:                user.userId,
      email:             user.email,
      first_name:        user.firstName,
      last_name:         user.lastName,
      level:             user.level,
      roles:             user.roles,
      bacenta_id:        user.bacenta?.id        || null,
      bacenta_name:      user.bacenta?.name      || null,
      governorship_id:   user.governorship?.id   || null,
      governorship_name: user.governorship?.name || null,
      council_name:      user.council?.name      || null,
      stream_id:         user.stream?.id         || null,
      stream_name:       user.stream?.name       || null,
      updated_at:        new Date().toISOString(),
    }, { onConflict: 'id' })
  if (error) throw error
}
```

---

## Updated Login Flow (src/utils/auth.js addition)

After a successful login, do these three things in order:

```js
import { setSupabaseAuth }  from './supabase'
import { upsertProfile }    from './logs'

export async function loginWithCredentials(email, password) {
  // 1. Call external auth API
  const res  = await fetch(`${import.meta.env.VITE_AUTH_API_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.message || 'Login failed')

  // 2. Store tokens
  localStorage.setItem('accessToken',  data.tokens.accessToken)
  localStorage.setItem('refreshToken', data.tokens.refreshToken)

  // 3. Give Supabase the token so RLS knows who this is
  await setSupabaseAuth(data.tokens.accessToken)

  // 4. Build enriched user object
  const payload = decodeJWT(data.tokens.accessToken)
  const user    = enrichUser({ ...payload, ...data.user })

  // 5. Sync profile to Supabase
  await upsertProfile(user)

  return user
}
```

---

## Looker Studio (optional — oversight dashboard)

Supabase Postgres can connect directly to Looker Studio via the PostgreSQL
connector, giving overseers a read-only dashboard at no extra cost.

Connection details (from Supabase > Settings > Database):
- Host: `db.your-project.supabase.co`
- Port: `5432`
- Database: `postgres`
- User: `postgres` (or a read-only role you create)

Useful views to build in Looker Studio:
- Activities logged per governorship per month
- Outreach attendance trends by level
- Visitation completion rate by council
- Activity frequency heatmap (which activities are getting skipped)

---

## Migration from localStorage

When switching from localStorage to Supabase, run this one-time migration
in the browser console for any user who already has local data:

```js
import { addLog }  from './utils/logs'
import { supabase } from './utils/supabase'

async function migrateLocalLogs(user) {
  const key      = `pvcio_logs_${user.userId}`
  const existing = JSON.parse(localStorage.getItem(key) || '[]')
  if (!existing.length) return

  for (const entry of existing.reverse()) { // oldest first
    await addLog(user, {
      activityId:   entry.activityId,
      activityName: entry.activityName,
      category:     entry.category,
      level:        entry.level,
      freq:         entry.freq || 'flexible',
      fields:       entry.fields,
    })
  }
  localStorage.removeItem(key)
  console.log(`Migrated ${existing.length} logs for ${user.firstName}`)
}
```

---

## Install

```bash
npm install @supabase/supabase-js
```

---

## Checklist before going live

- [ ] Supabase project created at supabase.com
- [ ] SQL schema run (tables + indexes)
- [ ] RLS policies applied
- [ ] `activity-photos` storage bucket created with RLS
- [ ] JWT secret in Supabase matches the external auth system's secret
- [ ] `.env` file has VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
- [ ] `loginWithCredentials()` calls `setSupabaseAuth()` and `upsertProfile()`
- [ ] `addLog()` updated to use Supabase version (not localStorage)
- [ ] Tested: submit a log, check it appears in Supabase table editor
- [ ] Tested: upload a photo, check it appears in Storage bucket
