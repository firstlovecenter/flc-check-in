// Admin-only member detail page. Reached from MemberBiometrics by clicking
// a row. Shows everything we know about a member from member_profiles plus
// a list of events they've personally checked in to.

import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { format } from 'date-fns'
import ScreenHeader from '../../components/ScreenHeader'
import {
  getMemberProfile, listEventsAttendedByMember, adminClearFaceDescriptor,
} from '../../utils/supabaseCheckins'

type Status = 'loading' | 'ok' | 'error'

const HIERARCHY: Array<{ key: string; label: string }> = [
  { key: 'denomination', label: 'Denomination' },
  { key: 'oversight',    label: 'Oversight' },
  { key: 'campus',       label: 'Campus' },
  { key: 'stream',       label: 'Stream' },
  { key: 'council',      label: 'Council' },
  { key: 'governorship', label: 'Governorship' },
  { key: 'bacenta',      label: 'Bacenta' },
]

export default function MemberDetailScreen() {
  const { memberId = '' } = useParams()
  const [status, setStatus] = useState<Status>('loading')
  const [profile, setProfile] = useState<any | null>(null)
  const [events, setEvents] = useState<any[]>([])
  const [error, setError] = useState<string | null>(null)
  const [resetBusy, setResetBusy] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)

  async function load() {
    setStatus('loading')
    setError(null)
    try {
      const [p, evs] = await Promise.all([
        getMemberProfile(memberId),
        listEventsAttendedByMember(memberId),
      ])
      setProfile(p)
      setEvents(evs || [])
      setStatus('ok')
    } catch (err: any) {
      setError(err.message || 'Could not load member')
      setStatus('error')
    }
  }

  useEffect(() => { if (memberId) load() }, [memberId]) // eslint-disable-line

  async function handleClearFace() {
    setResetBusy(true)
    setError(null)
    try {
      await adminClearFaceDescriptor(memberId)
      // Re-fetch the profile so the badge updates.
      const p = await getMemberProfile(memberId)
      setProfile(p)
      setConfirmReset(false)
    } catch (err: any) {
      setError(err.message || 'Reset failed')
    } finally {
      setResetBusy(false)
    }
  }

  const name = profile
    ? [profile.title, profile.first_name, profile.last_name].filter(Boolean).join(' ') || profile.id
    : '—'
  const initials = profile
    ? [profile.first_name?.[0], profile.last_name?.[0]].filter(Boolean).join('').toUpperCase() || '?'
    : '?'

  return (
    <div className='min-h-dvh' style={{ background: 'var(--bg)' }}>
      <ScreenHeader title='Member' back={{ to: '/admin/biometrics', label: 'Biometrics' }} />
      <main className='max-w-3xl mx-auto px-4 py-6 flex flex-col gap-4'>

        {status === 'loading' && <p className='text-sm text-center' style={{ color: 'var(--muted)' }}>Loading…</p>}
        {status === 'error' && (
          <p className='text-sm text-center' style={{ color: 'var(--coral)' }}>{error}</p>
        )}

        {profile && (
          <>
            {/* Identity card */}
            <div
              className='p-5 flex items-center gap-4'
              style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-card)', boxShadow: 'var(--shadow-2)' }}
            >
              <Avatar pictureUrl={profile.picture_url} initials={initials} size={72} />
              <div className='min-w-0 flex-1'>
                <h2 className='text-lg font-bold m-0 truncate' style={{ color: 'var(--text)', letterSpacing: '-0.02em' }}>
                  {name}
                </h2>
                {profile.email && (
                  <p className='text-xs m-0 mt-0.5 truncate' style={{ color: 'var(--muted)' }}>
                    {profile.email}
                  </p>
                )}
                {profile.phone && (
                  <p className='text-xs m-0 mt-0.5 truncate' style={{ color: 'var(--muted)' }}>
                    {profile.phone}
                  </p>
                )}
              </div>
            </div>

            {/* Roles */}
            {Array.isArray(profile.roles) && profile.roles.length > 0 && (
              <Section title='Roles'>
                <div className='flex flex-wrap gap-1.5'>
                  {profile.roles.map((r: string) => (
                    <span
                      key={r}
                      className='text-xs px-2.5 py-1 font-semibold'
                      style={{ background: 'var(--bg2)', color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: 'var(--radius-pill)' }}
                    >
                      {r}
                    </span>
                  ))}
                </div>
              </Section>
            )}

            {/* Hierarchy */}
            <Section title='Church hierarchy'>
              <div className='flex flex-col gap-1.5'>
                {HIERARCHY.map(({ key, label }) => {
                  const id = profile[`${key}_id`]
                  const name = profile[`${key}_name`]
                  if (!id) return null
                  return (
                    <div
                      key={key}
                      className='px-3 py-2 flex items-center justify-between gap-3'
                      style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-btn)' }}
                    >
                      <span className='eyebrow m-0'>{label}</span>
                      <span className='text-sm font-semibold truncate' style={{ color: 'var(--text)' }}>{name || id}</span>
                    </div>
                  )
                })}
                {HIERARCHY.every(({ key }) => !profile[`${key}_id`]) && (
                  <p className='text-sm' style={{ color: 'var(--muted)' }}>No hierarchy data on this member.</p>
                )}
              </div>
            </Section>

            {/* Biometrics */}
            <Section title='Biometrics'>
              <div
                className='px-4 py-3 flex items-center justify-between gap-3'
                style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-btn)' }}
              >
                <div className='min-w-0'>
                  <p className='text-sm font-semibold m-0' style={{ color: 'var(--text)' }}>Face ID</p>
                  <p className='text-xs m-0 mt-0.5' style={{ color: 'var(--muted)' }}>
                    {profile.has_face_id ? 'Enrolled — descriptor on file.' : 'Not enrolled yet.'}
                  </p>
                </div>
                {profile.has_face_id && (
                  confirmReset ? (
                    <div className='flex gap-1.5 shrink-0'>
                      <button
                        type='button'
                        onClick={() => setConfirmReset(false)}
                        disabled={resetBusy}
                        className='text-xs px-3 py-1.5 cursor-pointer'
                        style={{ background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--radius-btn)' }}
                      >Cancel</button>
                      <button
                        type='button'
                        onClick={handleClearFace}
                        disabled={resetBusy}
                        className='text-xs px-3 py-1.5 cursor-pointer disabled:opacity-50'
                        style={{ background: 'transparent', color: 'var(--coral)', border: '1.5px solid var(--coral)', borderRadius: 'var(--radius-btn)' }}
                      >{resetBusy ? 'Resetting…' : 'Confirm reset'}</button>
                    </div>
                  ) : (
                    <button
                      type='button'
                      onClick={() => setConfirmReset(true)}
                      className='text-xs px-3 py-1.5 cursor-pointer shrink-0'
                      style={{ background: 'transparent', color: 'var(--coral)', border: '1.5px solid var(--coral)', borderRadius: 'var(--radius-btn)' }}
                    >Reset Face ID</button>
                  )
                )}
              </div>
              {error && <p className='text-xs mt-2' style={{ color: 'var(--coral)' }}>{error}</p>}
            </Section>

            {/* Attendance */}
            <Section title={`Attendance (${events.length})`}>
              {events.length === 0 && (
                <p className='text-sm' style={{ color: 'var(--muted)' }}>No event check-ins yet.</p>
              )}
              <div className='flex flex-col gap-1.5'>
                {events.slice(0, 20).map((evt) => (
                  <Link
                    key={evt.id}
                    to={`/events/${evt.id}`}
                    className='px-3 py-2.5 flex items-center justify-between gap-3'
                    style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-btn)', textDecoration: 'none' }}
                  >
                    <div className='min-w-0'>
                      <p className='text-sm font-semibold m-0 truncate' style={{ color: 'var(--text)' }}>{evt.name}</p>
                      <p className='text-xs m-0 mt-0.5 truncate' style={{ color: 'var(--muted)' }}>
                        {evt.scope_level} · {evt.scope_church_name} · {format(new Date(evt.starts_at), 'PP')}
                      </p>
                    </div>
                    <span
                      className='text-[10px] px-2 py-0.5 uppercase font-bold shrink-0'
                      style={{
                        background: evt.status === 'ACTIVE' ? 'rgba(46,203,143,0.12)' : 'var(--bg2)',
                        color: evt.status === 'ACTIVE' ? 'var(--green)' : 'var(--muted)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-pill)',
                        letterSpacing: '0.06em',
                      }}
                    >{evt.status}</span>
                  </Link>
                ))}
                {events.length > 20 && (
                  <p className='text-xs text-center mt-1' style={{ color: 'var(--muted)' }}>
                    Showing 20 most recent of {events.length}
                  </p>
                )}
              </div>
            </Section>
          </>
        )}
      </main>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className='flex flex-col gap-2'>
      <p className='eyebrow'>{title}</p>
      {children}
    </section>
  )
}

function Avatar({ pictureUrl, initials, size }: { pictureUrl: string | null; initials: string; size: number }) {
  const common: React.CSSProperties = {
    width: size, height: size,
    borderRadius: '50%',
    border: '1.5px solid var(--border)',
    flexShrink: 0,
    background: 'var(--bg2)',
  }
  if (pictureUrl) {
    return (
      <img
        src={pictureUrl}
        alt={initials}
        width={size}
        height={size}
        decoding='async'
        style={{ ...common, objectFit: 'cover' }}
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
      />
    )
  }
  return (
    <div
      aria-label={initials}
      style={{
        ...common,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--muted)',
        fontSize: Math.round(size * 0.36),
        fontWeight: 700,
      }}
    >{initials}</div>
  )
}
