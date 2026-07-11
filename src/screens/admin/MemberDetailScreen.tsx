import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { format } from 'date-fns'
import ScreenHeader from '../../components/ScreenHeader'
import Spinner from '../../components/Spinner'
import { PageShell, PageMain } from '../../components/layout/PageShell'
import { Badge } from '../../components/ui/badge'
import { PaginationControls, useClientPagination } from '../../components/PaginationControls'
import { cn } from '../../lib/utils'
import {
  getMemberProfile, listEventsAttendedByMember,
} from '../../utils/supabaseCheckins'

type Status = 'loading' | 'ok' | 'error'

const EVENTS_PAGE_SIZE = 5

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
  const eventsPage = useClientPagination(events, EVENTS_PAGE_SIZE, events.length)
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

  const name = profile
    ? [profile.title, profile.first_name, profile.last_name].filter(Boolean).join(' ') || profile.id
    : '—'
  const initials = profile
    ? [profile.first_name?.[0], profile.last_name?.[0]].filter(Boolean).join('').toUpperCase() || '?'
    : '?'

  return (
    <PageShell>
      <ScreenHeader title='Member' back={{ to: '/admin/members', label: 'Members' }} />
      <PageMain className='max-w-3xl flex flex-col gap-4'>

        {status === 'loading' && <Spinner />}
        {status === 'error' && (
          <p className='text-sm text-center text-destructive'>{error}</p>
        )}

        {profile && (
          <>
            {/* Identity card */}
            <div
              className='p-5 flex items-center gap-4 surface-card'
            >
              <Avatar pictureUrl={profile.picture_url} initials={initials} size={72} />
              <div className='min-w-0 flex-1'>
                <h2 className='m-0 truncate text-lg font-bold tracking-tight text-foreground'>
                  {name}
                </h2>
                {profile.email && (
                  <p className='text-xs m-0 mt-0.5 truncate text-muted-foreground'>
                    {profile.email}
                  </p>
                )}
                {profile.phone && (
                  <p className='text-xs m-0 mt-0.5 truncate text-muted-foreground'>
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
                    <Badge key={r} variant='muted'>
                      {r}
                    </Badge>
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
                      className='px-3 py-2 flex items-center justify-between gap-3 rounded-lg border border-border bg-secondary'
                    >
                      <span className='eyebrow m-0'>{label}</span>
                      <span className='text-sm font-semibold truncate text-foreground'>{name || id}</span>
                    </div>
                  )
                })}
                {HIERARCHY.every(({ key }) => !profile[`${key}_id`]) && (
                  <p className='text-sm text-muted-foreground'>No hierarchy data on this member.</p>
                )}
              </div>
            </Section>

            {/* Attendance */}
            <Section title={`Attendance (${events.length})`}>
              {events.length === 0 && (
                <p className='text-sm text-muted-foreground'>No event check-ins yet.</p>
              )}
              <div className='flex flex-col gap-1.5'>
                {eventsPage.pageItems.map((evt) => (
                  <Link
                    key={evt.id}
                    to={`/events/${evt.id}`}
                    className='list-row flex items-center justify-between gap-3 rounded-lg border border-border bg-secondary px-3 py-2.5 no-underline'
                  >
                    <div className='min-w-0'>
                      <p className='text-sm font-semibold m-0 truncate text-foreground'>{evt.name}</p>
                      <p className='text-xs m-0 mt-0.5 truncate text-muted-foreground'>
                        {evt.scope_level} · {evt.scope_church_name} · {format(new Date(evt.starts_at), 'PP')}
                      </p>
                    </div>
                    <Badge variant={evt.status === 'ACTIVE' ? 'success' : 'muted'} className='shrink-0'>
                      {evt.status}
                    </Badge>
                  </Link>
                ))}
                <PaginationControls
                  page={eventsPage.page}
                  totalPages={eventsPage.totalPages}
                  total={eventsPage.total}
                  pageSize={EVENTS_PAGE_SIZE}
                  onPageChange={eventsPage.setPage}
                  noun='events'
                />
              </div>
            </Section>
          </>
        )}
      </PageMain>
    </PageShell>
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
  const cls = cn('shrink-0 rounded-full border border-border bg-secondary object-cover')
  if (pictureUrl) {
    return (
      <img
        src={pictureUrl}
        alt={initials}
        width={size}
        height={size}
        decoding='async'
        className={cls}
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
      />
    )
  }
  return (
    <div
      aria-label={initials}
      className={cn(cls, 'flex items-center justify-center font-bold text-muted-foreground')}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
    >
      {initials}
    </div>
  )
}
