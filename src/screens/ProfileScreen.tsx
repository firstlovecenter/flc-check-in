import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ScreenHeader from '../components/ScreenHeader'
import Spinner from '../components/Spinner'
import { PageShell, PageMainNarrow } from '../components/layout/PageShell'
import { Card, CardContent } from '../components/ui/card'
import { Alert } from '../components/ui/alert'
import { Badge } from '../components/ui/badge'
import { Label } from '../components/ui/label'
import { cn } from '../lib/utils'
import { getCurrentUser } from '../utils/auth'
import { resolveCurrentMember } from '../utils/membersApi'
import { getAttendanceStats } from '../utils/supabaseCheckins'

const LEVEL_ORDER = ['denomination', 'oversight', 'campus', 'stream', 'council', 'governorship', 'bacenta']

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className='flex flex-col gap-3'>
      <Label className='section-heading'>{title}</Label>
      {children}
    </div>
  )
}

function Row({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null
  return (
    <div className='flex flex-col gap-0.5'>
      <p className='m-0 text-xs text-muted-foreground'>{label}</p>
      <p className='m-0 text-sm font-semibold text-foreground'>{value}</p>
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
  push('oversight', pickFirst(member.leadsOversight) || pickFirst(member.isAdminForOversight), pickFirst(member.leadsOversight) ? 'Leader' : 'Admin')
  push('campus', pickFirst(member.leadsCampus) || pickFirst(member.isAdminForCampus), pickFirst(member.leadsCampus) ? 'Leader' : 'Admin')
  push('stream', pickFirst(member.leadsStream) || pickFirst(member.isAdminForStream), pickFirst(member.leadsStream) ? 'Leader' : 'Admin')
  push('council', pickFirst(member.leadsCouncil) || pickFirst(member.isAdminForCouncil), pickFirst(member.leadsCouncil) ? 'Leader' : 'Admin')
  push('governorship', pickFirst(member.leadsGovernorship) || pickFirst(member.isAdminForGovernorship), pickFirst(member.leadsGovernorship) ? 'Leader' : 'Admin')
  if (leadsBackenta) push('bacenta', leadsBackenta, 'Leader')
  if (member.bacenta?.name && !leadsBackenta) push('bacenta', member.bacenta, 'Member')

  return entries.sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level))
}

export default function ProfileScreen() {
  const { t } = useTranslation()
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
        if (!cancelled) setError(err.message || t('profile.loadError'))
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
  const memberTitle = Array.isArray(member?.title) ? member.title[0]?.name : member?.title
  const displayName = member
    ? [memberTitle, member.firstName, member.middleName, member.lastName].filter(Boolean).join(' ')
    : [user?.title, user?.firstName, user?.lastName].filter(Boolean).join(' ')
  const pictureUrl = member?.pictureUrl || null

  return (
    <PageShell>
      <ScreenHeader title={t('nav.myProfile')} back={{ to: '/home', label: t('nav.home') }} />
      <PageMainNarrow className='flex flex-col gap-6'>
        <Card>
          <CardContent className='flex flex-col items-center gap-4 p-6'>
            {pictureUrl ? (
              <img
                src={pictureUrl}
                alt={displayName}
                width={88}
                height={88}
                decoding='async'
                className='size-[88px] rounded-full border-2 border-border object-cover'
              />
            ) : (
              <div className='flex size-[88px] items-center justify-center rounded-full border-2 border-border bg-secondary text-[32px] font-bold text-muted-foreground'>
                {(displayName?.[0] || '?').toUpperCase()}
              </div>
            )}

            {loading ? (
              <Spinner fullPage={false} />
            ) : (
              <>
                <div className='text-center'>
                  <p className='m-0 text-lg font-bold tracking-tight text-foreground'>
                    {displayName || t('profile.unknown')}
                  </p>
                  {user?.email && (
                    <p className='m-0 mt-0.5 text-sm text-muted-foreground'>{user.email}</p>
                  )}
                </div>
                {user?.level && <Badge className='uppercase tracking-wider'>{user.level}</Badge>}
              </>
            )}
          </CardContent>
        </Card>

        {error && (
          <Alert variant='destructive' className='text-center'>
            {error} — {t('profile.cachedOnly')}
          </Alert>
        )}

        {!loading && member && (
          <>
            {(member.phoneNumber || member.whatsappNumber || member.email) && (
              <Card>
                <CardContent className='flex flex-col gap-4 p-5'>
                  <Section title={t('profile.contact')}>
                    <Row label={t('profile.phone')} value={member.phoneNumber} />
                    <Row
                      label={t('profile.whatsapp')}
                      value={member.whatsappNumber !== member.phoneNumber ? member.whatsappNumber : null}
                    />
                    <Row label={t('profile.email')} value={member.email} />
                  </Section>
                </CardContent>
              </Card>
            )}

            {hierarchy.length > 0 && (
              <Card>
                <CardContent className='flex flex-col gap-4 p-5'>
                  <Section title={t('profile.churchRoles')}>
                    <div className='flex flex-col gap-3'>
                      {hierarchy.map(({ level, name, role }) => (
                        <div key={level} className='flex items-center justify-between'>
                          <div>
                            <p className='m-0 text-xs uppercase tracking-wider text-muted-foreground'>{level}</p>
                            <p className='m-0 text-sm font-semibold text-foreground'>{name}</p>
                          </div>
                          <Badge variant={role === 'Leader' ? 'default' : 'muted'}>
                            {role === 'Leader' ? t('profile.roleLeader') : role === 'Admin' ? t('profile.roleAdmin') : t('profile.roleMember')}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  </Section>
                </CardContent>
              </Card>
            )}

            {stats && (
              <Card>
                <CardContent className='flex flex-col gap-4 p-5'>
                  <Section title={t('profile.attendanceStats')}>
                    <div className='metric-grid grid-cols-2'>
                      <StatBox label={t('profile.present')} value={String(stats.presentCount)} tone='success' />
                      <StatBox
                        label={t('profile.absent')}
                        value={String(stats.absentCount)}
                        tone={stats.absentCount > 0 ? 'destructive' : undefined}
                      />
                    </div>
                    {stats.lastCheckIn && (
                      <p className='m-0 text-xs text-muted-foreground'>
                        {t('profile.lastCheckIn')}{' '}
                        <span className='text-foreground'>
                          {new Date(stats.lastCheckIn).toLocaleDateString(undefined, {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                          })}
                        </span>
                      </p>
                    )}
                  </Section>
                </CardContent>
              </Card>
            )}
          </>
        )}

        {!loading && !member && !error && (
          <Card>
            <CardContent className='p-5 text-center'>
              <p className='m-0 text-sm text-muted-foreground'>
                {t('profile.notLoadedBody')}
              </p>
            </CardContent>
          </Card>
        )}
      </PageMainNarrow>
    </PageShell>
  )
}

function StatBox({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'success' | 'warning' | 'destructive'
}) {
  return (
    <div className='metric-tile flex flex-col gap-0.5 p-3'>
      <p className='m-0 text-xs uppercase tracking-wider text-muted-foreground'>{label}</p>
      <p
        className={cn(
          'tnum m-0 text-xl font-bold tracking-tight',
          tone === 'success' && 'text-success',
          tone === 'warning' && 'text-warning',
          tone === 'destructive' && 'text-destructive',
          !tone && 'text-foreground',
        )}
      >
        {value}
      </p>
    </div>
  )
}
