import { useEffect, useState } from 'react'
import ScreenHeader from '../components/ScreenHeader'
import { getCurrentUser } from '../utils/auth'
import { resolveCurrentMember } from '../utils/membersApi'
import { getAttendanceStats } from '../utils/supabaseCheckins'

const LEVEL_ORDER = ['denomination', 'oversight', 'campus', 'stream', 'council', 'governorship', 'bacenta']

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className='flex flex-col gap-3'>
      <p className='eyebrow m-0' style={{ color: 'var(--muted)' }}>{title}</p>
      {children}
    </div>
  )
}

function Row({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null
  return (
    <div className='flex flex-col gap-0.5'>
      <p className='text-xs m-0' style={{ color: 'var(--muted)' }}>{label}</p>
      <p className='text-sm font-semibold m-0' style={{ color: 'var(--text)' }}>{value}</p>
    </div>
  )
}

function pickFirst(arr) {
  return Array.isArray(arr) && arr.length > 0 ? arr[0] : null
}

function buildHierarchy(member) {
  if (!member) return []
  const leadsBackenta = pickFirst(member.leadsBacenta)
  const entries: { level: string; name: string; role: string }[] = []

  const push = (levelKey: string, node: any, role: string) => {
    if (node?.name) entries.push({ level: levelKey, name: node.name, role })
  }

  push('denomination', pickFirst(member.leadsDenomination) || pickFirst(member.isAdminForDenomination), pickFirst(member.leadsDenomination) ? 'Leader' : 'Admin')
  push('oversight',    pickFirst(member.leadsOversight)    || pickFirst(member.isAdminForOversight),    pickFirst(member.leadsOversight)    ? 'Leader' : 'Admin')
  push('campus',       pickFirst(member.leadsCampus)       || pickFirst(member.isAdminForCampus),       pickFirst(member.leadsCampus)       ? 'Leader' : 'Admin')
  push('stream',       pickFirst(member.leadsStream)       || pickFirst(member.isAdminForStream),       pickFirst(member.leadsStream)       ? 'Leader' : 'Admin')
  push('council',      pickFirst(member.leadsCouncil)      || pickFirst(member.isAdminForCouncil),      pickFirst(member.leadsCouncil)      ? 'Leader' : 'Admin')
  push('governorship', pickFirst(member.leadsGovernorship) || pickFirst(member.isAdminForGovernorship), pickFirst(member.leadsGovernorship) ? 'Leader' : 'Admin')
  if (leadsBackenta) push('bacenta', leadsBackenta, 'Leader')
  if (member.bacenta?.name && !leadsBackenta) push('bacenta', member.bacenta, 'Member')

  return entries.sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level))
}

export default function ProfileScreen() {
  const user = getCurrentUser()
  const [member, setMember] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [stats, setStats] = useState<any>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const m = await resolveCurrentMember(user)
        if (!cancelled) setMember(m)
      } catch (err: any) {
        if (!cancelled) setError(err.message || 'Could not load profile.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const id = member?.id || user?.userId
    if (!id) return
    getAttendanceStats(id)
      .then(setStats)
      .catch(() => {})
  }, [member?.id, user?.userId])

  const hierarchy = buildHierarchy(member)
  const displayName = member
    ? [member.title, member.firstName, member.middleName, member.lastName].filter(Boolean).join(' ')
    : [user?.title, user?.firstName, user?.lastName].filter(Boolean).join(' ')
  const pictureUrl = member?.pictureUrl || null

  return (
    <div className='min-h-dvh flex flex-col' style={{ background: 'var(--bg)' }}>
      <ScreenHeader title='My Profile' back={{ to: '/home', label: 'Home' }} />

      <div className='flex-1 w-full max-w-lg mx-auto px-4 py-6 flex flex-col gap-6'>

        {/* Avatar + name */}
        <div
          className='p-6 flex flex-col items-center gap-4'
          style={{
            background: 'var(--card)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-card)',
          }}
        >
          {pictureUrl ? (
            <img
              src={pictureUrl}
              alt={displayName}
              width={88}
              height={88}
              style={{ borderRadius: '50%', objectFit: 'cover', border: '2px solid var(--border)' }}
            />
          ) : (
            <div
              className='flex items-center justify-center'
              style={{
                width: 88, height: 88,
                borderRadius: '50%',
                background: 'var(--bg2)',
                border: '2px solid var(--border)',
                fontSize: 32,
                color: 'var(--muted)',
                fontWeight: 700,
              }}
            >
              {(displayName?.[0] || '?').toUpperCase()}
            </div>
          )}

          {loading ? (
            <p className='text-sm m-0' style={{ color: 'var(--muted)' }}>Loading…</p>
          ) : (
            <>
              <div className='text-center'>
                <p className='text-lg font-bold m-0' style={{ color: 'var(--text)', letterSpacing: '-0.02em' }}>
                  {displayName || 'Unknown'}
                </p>
                {user?.email && (
                  <p className='text-sm m-0 mt-0.5' style={{ color: 'var(--muted)' }}>{user.email}</p>
                )}
              </div>
              {user?.level && (
                <span
                  className='text-xs font-bold uppercase tracking-wider px-3 py-1'
                  style={{
                    background: 'var(--accent)',
                    color: 'var(--bg)',
                    borderRadius: 'var(--radius-pill)',
                    letterSpacing: '0.06em',
                  }}
                >
                  {user.level}
                </span>
              )}
            </>
          )}
        </div>

        {error && (
          <p
            className='text-sm px-4 py-3 m-0 text-center'
            style={{
              color: 'var(--coral)',
              background: 'rgba(232,96,74,0.08)',
              border: '1px solid rgba(232,96,74,0.25)',
              borderRadius: 'var(--radius-btn)',
            }}
          >
            {error} — showing cached info only.
          </p>
        )}

        {!loading && member && (
          <>
            {/* Contact */}
            {(member.phoneNumber || member.whatsappNumber || member.email) && (
              <div
                className='p-5 flex flex-col gap-4'
                style={{
                  background: 'var(--card)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-card)',
                }}
              >
                <Section title='Contact'>
                  <Row label='Phone'    value={member.phoneNumber} />
                  <Row label='WhatsApp' value={member.whatsappNumber !== member.phoneNumber ? member.whatsappNumber : null} />
                  <Row label='Email'    value={member.email} />
                </Section>
              </div>
            )}

            {/* Church hierarchy */}
            {hierarchy.length > 0 && (
              <div
                className='p-5 flex flex-col gap-4'
                style={{
                  background: 'var(--card)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-card)',
                }}
              >
                <Section title='Church Roles'>
                  <div className='flex flex-col gap-3'>
                    {hierarchy.map(({ level, name, role }) => (
                      <div key={level} className='flex items-center justify-between'>
                        <div>
                          <p className='text-xs m-0 uppercase tracking-wider' style={{ color: 'var(--muted)' }}>{level}</p>
                          <p className='text-sm font-semibold m-0' style={{ color: 'var(--text)' }}>{name}</p>
                        </div>
                        <span
                          className='text-xs font-bold px-2.5 py-1'
                          style={{
                            background: role === 'Leader' ? 'rgba(123,164,248,0.15)' : 'rgba(167,139,250,0.15)',
                            color: role === 'Leader' ? 'var(--accent)' : 'var(--purple)',
                            borderRadius: 'var(--radius-pill)',
                            letterSpacing: '0.04em',
                          }}
                        >
                          {role}
                        </span>
                      </div>
                    ))}
                  </div>
                </Section>
              </div>
            )}

            {/* Attendance stats */}
            {stats && (
              <div
                className='p-5 flex flex-col gap-4'
                style={{
                  background: 'var(--card)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-card)',
                }}
              >
                <Section title='Attendance Stats'>
                  <div className='grid grid-cols-2 gap-3'>
                    <StatBox
                      label='Events Attended'
                      value={`${stats.attendedCount} / ${stats.scopedCount}`}
                    />
                    <StatBox
                      label='Attendance Rate'
                      value={stats.pct != null ? `${stats.pct}%` : '—'}
                      color={stats.pct == null ? undefined : stats.pct >= 80 ? 'var(--green)' : stats.pct >= 50 ? 'var(--amber)' : 'var(--coral)'}
                    />
                    <StatBox label='On Time'  value={String(stats.onTimeCount)} color='var(--green)' />
                    <StatBox label='Late'     value={String(stats.lateCount)}   color={stats.lateCount > 0 ? 'var(--amber)' : undefined} />
                  </div>
                  {stats.lastCheckIn && (
                    <p className='text-xs m-0' style={{ color: 'var(--muted)' }}>
                      Last check-in: <span style={{ color: 'var(--text)' }}>{new Date(stats.lastCheckIn).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</span>
                    </p>
                  )}
                </Section>
              </div>
            )}
          </>
        )}

        {!loading && !member && !error && (
          <div
            className='p-5 text-center'
            style={{
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-card)',
            }}
          >
            <p className='text-sm m-0' style={{ color: 'var(--muted)' }}>
              Profile details could not be loaded from the FLC directory. Your account information is still available above.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function StatBox({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div
      className='p-3 flex flex-col gap-0.5'
      style={{
        background: 'var(--bg2)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-btn)',
      }}
    >
      <p className='text-xs m-0 uppercase tracking-wider' style={{ color: 'var(--muted)' }}>{label}</p>
      <p className='text-xl font-bold m-0' style={{ color: color || 'var(--text)', letterSpacing: '-0.02em' }}>{value}</p>
    </div>
  )
}
