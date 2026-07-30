import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import ScreenHeader from '../../components/ScreenHeader'
import { PageShell, PageMain } from '../../components/layout/PageShell'
import Spinner from '../../components/Spinner'
import { getCurrentUser } from '../../utils/auth'
import {
  listSpecialGroups, getSpecialGroup, createSpecialGroup, updateSpecialGroup,
  deleteSpecialGroup, listSpecialGroupMembers, addMembersToSpecialGroup,
  removeMemberFromSpecialGroup, searchMemberProfiles,
  type SpecialGroup, type SpecialGroupMember,
} from '../../utils/supabaseCheckins'

// ─── View state machine ───────────────────────────────────────────────────────
type View =
  | { kind: 'list' }
  | { kind: 'detail'; groupId: string }
  | { kind: 'form'; groupId: string | null }   // null = create, string = edit

export default function SpecialGroupsScreen() {
  const { t } = useTranslation()
  const user = getCurrentUser()
  const navigate = useNavigate()

  if (!user?.isSuperAdmin) {
    navigate('/home', { replace: true })
    return null
  }

  const [view, setView] = useState<View>({ kind: 'list' })

  return (
    <PageShell>
      <ScreenHeader
        title={t('groups.title')}
        back={view.kind !== 'list' ? undefined : undefined}
        onBack={view.kind !== 'list' ? () => {
          if (view.kind === 'detail') setView({ kind: 'list' })
          if (view.kind === 'form') setView(view.groupId ? { kind: 'detail', groupId: view.groupId } : { kind: 'list' })
        } : undefined}
      />
      <PageMain className='max-w-2xl'>
        {view.kind === 'list'   && <GroupList   userId={user.userId} onSelect={(id) => setView({ kind: 'detail', groupId: id })} onCreate={() => setView({ kind: 'form', groupId: null })} />}
        {view.kind === 'detail' && <GroupDetail groupId={view.groupId} onBack={() => setView({ kind: 'list' })} onEdit={(id) => setView({ kind: 'form', groupId: id })} />}
        {view.kind === 'form'   && <GroupForm   groupId={view.groupId} userId={user.userId} onSaved={(id) => setView({ kind: 'detail', groupId: id })} onCancel={() => setView(view.groupId ? { kind: 'detail', groupId: view.groupId } : { kind: 'list' })} />}
      </PageMain>
    </PageShell>
  )
}

// ─── GroupList ────────────────────────────────────────────────────────────────
function GroupList({ userId, onSelect, onCreate }: { userId: string; onSelect: (id: string) => void; onCreate: () => void }) {
  const { t } = useTranslation()
  const [groups, setGroups] = useState<SpecialGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listSpecialGroups()
      .then(setGroups)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Spinner />
  if (error) return <ErrorBox>{error}</ErrorBox>

  return (
    <div className='flex flex-col gap-5'>
      <div className='flex items-center justify-between'>
        <p className='text-xs m-0 text-muted-foreground'>
          {t('groups.listIntro')}
        </p>
      </div>
      <button
        type='button'
        onClick={onCreate}
        className='btn-pill btn-primary flex items-center gap-2 px-4 py-2.5 font-semibold text-sm cursor-pointer w-full justify-center'
      >
        <svg viewBox='0 0 24 24' width='16' height='16' fill='currentColor'><path d='M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z' /></svg>
        {t('groups.newGroup')}
      </button>

      {groups.length === 0 && (
        <div className='p-8 text-center surface-card'>
          <p className='text-sm m-0 text-muted-foreground'>{t('groups.none')}</p>
        </div>
      )}

      <div className='flex flex-col gap-2'>
        {groups.map((g) => (
          <button
            key={g.id}
            type='button'
            onClick={() => onSelect(g.id)}
            className='surface-card w-full cursor-pointer px-4 py-3.5 text-left transition-[border-color,transform] hover:border-primary/30 active:scale-[0.99]'
          >
            <div className='flex items-center justify-between gap-3'>
              <div className='min-w-0'>
                <p className='text-sm font-bold m-0 truncate tracking-tight text-foreground'>{g.name}</p>
                {g.description && (
                  <p className='text-xs m-0 mt-0.5 truncate text-muted-foreground'>{g.description}</p>
                )}
              </div>
              <span className='chip shrink-0 px-2 py-0.5 text-xs font-semibold'>
                {g.member_count ?? 0} {g.member_count === 1 ? t('groups.person') : t('groups.people')}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── GroupDetail ──────────────────────────────────────────────────────────────
function GroupDetail({ groupId, onBack, onEdit }: { groupId: string; onBack: () => void; onEdit: (id: string) => void }) {
  const { t } = useTranslation()
  const [group, setGroup] = useState<SpecialGroup | null>(null)
  const [members, setMembers] = useState<SpecialGroupMember[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)

  // People search
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [searching, setSearching] = useState(false)
  const [adding, setAdding] = useState(false)

  function reload() {
    return Promise.all([
      getSpecialGroup(groupId),
      listSpecialGroupMembers(groupId),
    ]).then(([g, ms]) => {
      setGroup(g)
      setMembers(ms)
    })
  }

  useEffect(() => {
    reload().catch((e) => setError(e.message)).finally(() => setLoading(false))
  }, [groupId])

  // Debounced people search
  useEffect(() => {
    const q = search.trim()
    if (q.length < 2) { setSearchResults([]); return }
    let cancelled = false
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const res = await searchMemberProfiles(q, 10)
        if (!cancelled) setSearchResults(res)
      } catch {
        if (!cancelled) setSearchResults([])
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 300)
    return () => { cancelled = true; clearTimeout(t) }
  }, [search])

  async function handleAdd(m: any) {
    const name = [m.title, m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || m.id
    if (members.some((x) => x.member_id === m.id)) return
    setAdding(true)
    try {
      await addMembersToSpecialGroup(groupId, [{ id: m.id, name }])
      setSearch(''); setSearchResults([])
      await reload()
    } catch (e: any) { setError(e.message) }
    finally { setAdding(false) }
  }

  async function handleRemove(memberId: string) {
    setRemoving(memberId)
    try {
      await removeMemberFromSpecialGroup(groupId, memberId)
      setMembers((prev) => prev.filter((m) => m.member_id !== memberId))
    } catch (e: any) { setError(e.message) }
    finally { setRemoving(null) }
  }

  async function handleDelete() {
    if (!confirm(t('groups.deleteConfirm', { name: group?.name }))) return
    setDeleting(true)
    try {
      await deleteSpecialGroup(groupId)
      onBack()
    } catch (e: any) { setError(e.message); setDeleting(false) }
  }

  if (loading) return <Spinner />
  if (!group) return <ErrorBox>{t('groups.notFound')}</ErrorBox>

  const memberSet = new Set(members.map((m) => m.member_id))

  return (
    <div className='flex flex-col gap-5'>
      {/* Header card */}
      <div className='px-4 py-4 flex flex-col gap-3 surface-card'>
        <div className='flex items-start justify-between gap-3'>
          <div className='min-w-0'>
            <button type='button' onClick={onBack} className='text-xs cursor-pointer mb-1 border-0 bg-transparent p-0 text-primary'>{t('groups.allGroups')}</button>
            <h2 className='text-lg font-bold m-0 tracking-tight text-foreground'>{group.name}</h2>
            {group.description && <p className='text-sm m-0 mt-1 text-muted-foreground'>{group.description}</p>}
          </div>
          <div className='flex gap-2 shrink-0'>
            <button type='button' onClick={() => onEdit(groupId)}
              className='text-xs px-3 py-1.5 cursor-pointer font-semibold btn-pill btn-secondary'>
              {t('groups.edit')}
            </button>
            <button type='button' onClick={handleDelete} disabled={deleting}
              className='btn-destructive-outline cursor-pointer px-3 py-1.5 text-xs font-semibold disabled:opacity-50'>
              {deleting ? '…' : t('groups.delete')}
            </button>
          </div>
        </div>
        <p className='text-xs m-0 text-muted-foreground'>
          {members.length} {members.length === 1 ? t('groups.person') : t('groups.people')}
        </p>
      </div>

      {error && <ErrorBox>{error}</ErrorBox>}

      {/* Add people search */}
      <Section title={t('groups.addPeople')}>
        <div className='relative'>
          <input
            type='text'
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('groups.searchPlaceholder')}
            className='input-field'
            autoComplete='off'
            disabled={adding}
          />
          {searching && <p className='text-xs mt-1 text-muted-foreground'>{t('groups.searching')}</p>}
          {searchResults.length > 0 && (
            <SearchDropdown>
              {searchResults.map((m) => {
                const name = [m.title, m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || m.id
                const unit = m.bacenta_name || m.governorship_name || m.council_name || m.stream_name || m.campus_name || ''
                const already = memberSet.has(m.id)
                return (
                  <SearchDropdownItem
                    key={m.id}
                    label={name}
                    sublabel={unit}
                    pictureUrl={m.picture_url}
                    disabled={already}
                    onClick={() => handleAdd(m)}
                  />
                )
              })}
            </SearchDropdown>
          )}
          {!searching && search.trim().length >= 2 && searchResults.length === 0 && (
            <p className='text-xs mt-1 text-muted-foreground'>{t('groups.noMatches')}</p>
          )}
        </div>
      </Section>

      {/* Member list */}
      <Section title={t('groups.membersTitle', { count: members.length })}>
        {members.length === 0 && (
          <p className='text-sm text-center py-4 text-muted-foreground'>{t('groups.noMembers')}</p>
        )}
        <div className='flex flex-col gap-1.5'>
          {members.map((m) => {
            const name = m.member_name || m.member_id
            const initials = name.trim().split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()
            return (
            <div
              key={m.member_id}
              className='flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border border-border bg-secondary'
            >
              <div className='flex items-center gap-2.5 min-w-0'>
                <div className='avatar avatar--sm'>
                  {m.picture_url
                    ? <img src={m.picture_url} alt={name} />
                    : <span className='avatar-fallback'>{initials}</span>
                  }
                </div>
                <p className='text-sm font-semibold m-0 truncate text-foreground'>
                  {name}
                </p>
              </div>
              <button
                type='button'
                onClick={() => handleRemove(m.member_id)}
                disabled={removing === m.member_id}
                className='chip shrink-0 cursor-pointer px-2.5 py-1 text-xs disabled:opacity-50'
              >
                {removing === m.member_id ? '…' : t('groups.remove')}
              </button>
            </div>
          )})}
        </div>
      </Section>
    </div>
  )
}

// ─── GroupForm ────────────────────────────────────────────────────────────────
function GroupForm({ groupId, userId, onSaved, onCancel }: {
  groupId: string | null
  userId: string
  onSaved: (id: string) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [loading, setLoading] = useState(!!groupId)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!groupId) return
    getSpecialGroup(groupId)
      .then((g) => { if (g) { setName(g.name); setDescription(g.description || '') } })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [groupId])

  async function handleSubmit(e) {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    setError(null)
    try {
      if (groupId) {
        await updateSpecialGroup(groupId, { name, description })
        onSaved(groupId)
      } else {
        const g = await createSpecialGroup({ name, description, createdBy: userId })
        onSaved(g.id)
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <Spinner />

  return (
    <form onSubmit={handleSubmit} className='flex flex-col gap-5'>
      <p className='eyebrow m-0'>{groupId ? t('groups.form.edit') : t('groups.form.new')}</p>

      <Section title={t('groups.form.details')}>
        <Field label={t('groups.form.nameLabel')}>
          <input
            type='text'
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className='input-field'
            placeholder={t('groups.form.namePlaceholder')}
            autoFocus
          />
        </Field>
        <Field label={t('groups.form.descriptionLabel')}>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className='input-field resize-y'
            placeholder={t('groups.form.descriptionPlaceholder')}
            rows={3}
          />
        </Field>
      </Section>

      {error && <ErrorBox>{error}</ErrorBox>}

      <div className='flex gap-3'>
        <button type='button' onClick={onCancel}
          className='flex-1 py-3 font-semibold text-sm cursor-pointer btn-pill btn-secondary'>
          {t('groups.form.cancel')}
        </button>
        <button type='submit' disabled={saving || !name.trim()}
          className='flex-1 btn-pill btn-primary py-3 font-semibold text-sm cursor-pointer disabled:opacity-50'>
          {saving ? t('groups.form.saving') : groupId ? t('groups.form.saveChanges') : t('groups.form.create')}
        </button>
      </div>
    </form>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function Section({ title, children }) {
  return (
    <section className='flex flex-col gap-3'>
      <p className='eyebrow m-0'>{title}</p>
      {children}
    </section>
  )
}

function Field({ label, children }) {
  return (
    <div className='flex flex-col gap-1.5'>
      <label className='text-xs font-bold uppercase tracking-widest text-muted-foreground'>{label}</label>
      {children}
    </div>
  )
}

function ErrorBox({ children }) {
  return (
    <div className='p-3 text-sm rounded-lg border border-destructive/20 bg-destructive/10 text-destructive'>
      {children}
    </div>
  )
}

function SearchDropdown({ children }) {
  return <div className='search-dropdown'>{children}</div>
}

function SearchDropdownItem({ label, sublabel, pictureUrl, disabled, onClick }: {
  label: string; sublabel?: string; pictureUrl?: string | null; disabled?: boolean; onClick: () => void
}) {
  const initials = label ? label.trim().split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase() : '?'
  return (
    <button
      type='button'
      onClick={onClick}
      disabled={disabled}
      className='search-dropdown-item'
    >
      <div className='avatar avatar--md bg-secondary'>
        {pictureUrl
          ? <img src={pictureUrl} alt={label} width={32} height={32} />
          : <span className='avatar-fallback'>{initials}</span>
        }
      </div>
      <div className='min-w-0'>
        <div className='text-sm font-semibold truncate'>{label}</div>
        {sublabel && <div className='text-xs truncate mt-px text-muted-foreground'>{sublabel}</div>}
      </div>
    </button>
  )
}
