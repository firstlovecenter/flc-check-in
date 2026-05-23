import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ScreenHeader from '../../components/ScreenHeader'
import Spinner from '../../components/Spinner'
import { getCurrentUser } from '../../utils/auth'
import { searchMembersByName } from '../../utils/membersApi'
import {
  listSpecialGroups, getSpecialGroup, createSpecialGroup, updateSpecialGroup,
  deleteSpecialGroup, listSpecialGroupMembers, addMembersToSpecialGroup,
  removeMemberFromSpecialGroup,
  type SpecialGroup, type SpecialGroupMember,
} from '../../utils/supabaseCheckins'

// ─── View state machine ───────────────────────────────────────────────────────
type View =
  | { kind: 'list' }
  | { kind: 'detail'; groupId: string }
  | { kind: 'form'; groupId: string | null }   // null = create, string = edit

export default function SpecialGroupsScreen() {
  const user = getCurrentUser()
  const navigate = useNavigate()

  if (!user?.isSuperAdmin) {
    navigate('/home', { replace: true })
    return null
  }

  const [view, setView] = useState<View>({ kind: 'list' })

  return (
    <div className='min-h-dvh' style={{ background: 'var(--bg)' }}>
      <ScreenHeader
        title='Special Groups'
        back={view.kind !== 'list' ? undefined : undefined}
        onBack={view.kind !== 'list' ? () => {
          if (view.kind === 'detail') setView({ kind: 'list' })
          if (view.kind === 'form') setView(view.groupId ? { kind: 'detail', groupId: view.groupId } : { kind: 'list' })
        } : undefined}
      />
      <main className='max-w-2xl mx-auto px-4 sm:px-6 py-6'>
        {view.kind === 'list'   && <GroupList   userId={user.userId} onSelect={(id) => setView({ kind: 'detail', groupId: id })} onCreate={() => setView({ kind: 'form', groupId: null })} />}
        {view.kind === 'detail' && <GroupDetail groupId={view.groupId} onBack={() => setView({ kind: 'list' })} onEdit={(id) => setView({ kind: 'form', groupId: id })} />}
        {view.kind === 'form'   && <GroupForm   groupId={view.groupId} userId={user.userId} onSaved={(id) => setView({ kind: 'detail', groupId: id })} onCancel={() => setView(view.groupId ? { kind: 'detail', groupId: view.groupId } : { kind: 'list' })} />}
      </main>
    </div>
  )
}

// ─── GroupList ────────────────────────────────────────────────────────────────
function GroupList({ userId, onSelect, onCreate }: { userId: string; onSelect: (id: string) => void; onCreate: () => void }) {
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
        <p className='text-xs m-0' style={{ color: 'var(--muted)' }}>
          Groups let you define a reusable set of people that cuts across church scopes, for use when creating special meetings.
        </p>
      </div>
      <button
        type='button'
        onClick={onCreate}
        className='btn-pill btn-primary flex items-center gap-2 px-4 py-2.5 font-semibold text-sm cursor-pointer w-full justify-center'
      >
        <svg viewBox='0 0 24 24' width='16' height='16' fill='currentColor'><path d='M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z' /></svg>
        New group
      </button>

      {groups.length === 0 && (
        <div className='p-8 text-center' style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-card)' }}>
          <p className='text-sm m-0' style={{ color: 'var(--muted)' }}>No groups yet.</p>
        </div>
      )}

      <div className='flex flex-col gap-2'>
        {groups.map((g) => (
          <button
            key={g.id}
            type='button'
            onClick={() => onSelect(g.id)}
            className='w-full text-left px-4 py-3.5 cursor-pointer transition-all hover:brightness-105 active:scale-[0.99]'
            style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-card)', boxShadow: 'var(--shadow-1)' }}
          >
            <div className='flex items-center justify-between gap-3'>
              <div className='min-w-0'>
                <p className='text-sm font-bold m-0 truncate' style={{ color: 'var(--text)', letterSpacing: '-0.02em' }}>{g.name}</p>
                {g.description && (
                  <p className='text-xs m-0 mt-0.5 truncate' style={{ color: 'var(--muted)' }}>{g.description}</p>
                )}
              </div>
              <span className='shrink-0 text-xs font-semibold px-2 py-0.5' style={{ background: 'var(--bg2)', color: 'var(--muted)', borderRadius: 'var(--radius-pill)', border: '1px solid var(--border)' }}>
                {g.member_count ?? 0} {g.member_count === 1 ? 'person' : 'people'}
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
        const res = await searchMembersByName(q, 10)
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
    const name = m.fullName || `${m.firstName || ''} ${m.lastName || ''}`.trim()
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
    if (!confirm(`Delete group "${group?.name}"? This cannot be undone.`)) return
    setDeleting(true)
    try {
      await deleteSpecialGroup(groupId)
      onBack()
    } catch (e: any) { setError(e.message); setDeleting(false) }
  }

  if (loading) return <Spinner />
  if (!group) return <ErrorBox>Group not found.</ErrorBox>

  const memberSet = new Set(members.map((m) => m.member_id))

  return (
    <div className='flex flex-col gap-5'>
      {/* Header card */}
      <div className='px-4 py-4 flex flex-col gap-3' style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-card)' }}>
        <div className='flex items-start justify-between gap-3'>
          <div className='min-w-0'>
            <button type='button' onClick={onBack} className='text-xs cursor-pointer mb-1' style={{ background: 'none', border: 'none', color: 'var(--accent)', padding: 0 }}>← All groups</button>
            <h2 className='text-lg font-bold m-0' style={{ color: 'var(--text)', letterSpacing: '-0.02em' }}>{group.name}</h2>
            {group.description && <p className='text-sm m-0 mt-1' style={{ color: 'var(--muted)' }}>{group.description}</p>}
          </div>
          <div className='flex gap-2 shrink-0'>
            <button type='button' onClick={() => onEdit(groupId)}
              className='text-xs px-3 py-1.5 cursor-pointer font-semibold'
              style={{ background: 'var(--bg2)', border: '1.5px solid var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-btn)' }}>
              Edit
            </button>
            <button type='button' onClick={handleDelete} disabled={deleting}
              className='text-xs px-3 py-1.5 cursor-pointer font-semibold disabled:opacity-50'
              style={{ background: 'transparent', border: '1.5px solid color-mix(in oklab, var(--absent) 40%, transparent)', color: 'var(--coral)', borderRadius: 'var(--radius-btn)' }}>
              {deleting ? '…' : 'Delete'}
            </button>
          </div>
        </div>
        <p className='text-xs m-0' style={{ color: 'var(--muted)' }}>
          {members.length} {members.length === 1 ? 'person' : 'people'}
        </p>
      </div>

      {error && <ErrorBox>{error}</ErrorBox>}

      {/* Add people search */}
      <Section title='Add people'>
        <div style={{ position: 'relative' }}>
          <input
            type='text'
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder='Search by name…'
            className='input-field'
            autoComplete='off'
            disabled={adding}
          />
          {searching && <p className='text-xs mt-1' style={{ color: 'var(--muted)' }}>Searching…</p>}
          {searchResults.length > 0 && (
            <SearchDropdown>
              {searchResults.map((m) => {
                const name = m.fullName || `${m.firstName || ''} ${m.lastName || ''}`.trim()
                const already = memberSet.has(m.id)
                return (
                  <SearchDropdownItem
                    key={m.id}
                    label={name}
                    sublabel={memberLeadsLabel(m)}
                    pictureUrl={m.pictureUrl}
                    disabled={already}
                    onClick={() => handleAdd(m)}
                  />
                )
              })}
            </SearchDropdown>
          )}
          {!searching && search.trim().length >= 2 && searchResults.length === 0 && (
            <p className='text-xs mt-1' style={{ color: 'var(--muted)' }}>No matches.</p>
          )}
        </div>
      </Section>

      {/* Member list */}
      <Section title={`Members (${members.length})`}>
        {members.length === 0 && (
          <p className='text-sm text-center py-4' style={{ color: 'var(--muted)' }}>No members yet. Search above to add people.</p>
        )}
        <div className='flex flex-col gap-1.5'>
          {members.map((m) => {
            const name = m.member_name || m.member_id
            const initials = name.trim().split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()
            return (
            <div
              key={m.member_id}
              className='flex items-center justify-between gap-3 px-3 py-2.5'
              style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-btn)' }}
            >
              <div className='flex items-center gap-2.5 min-w-0'>
                <div className='shrink-0' style={{ width: 30, height: 30, borderRadius: '50%', overflow: 'hidden', background: 'var(--card)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {m.picture_url
                    ? <img src={m.picture_url} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)' }}>{initials}</span>
                  }
                </div>
                <p className='text-sm font-semibold m-0 truncate' style={{ color: 'var(--text)' }}>
                  {name}
                </p>
              </div>
              <button
                type='button'
                onClick={() => handleRemove(m.member_id)}
                disabled={removing === m.member_id}
                className='shrink-0 text-xs px-2.5 py-1 cursor-pointer disabled:opacity-50'
                style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)', borderRadius: 'var(--radius-pill)' }}
              >
                {removing === m.member_id ? '…' : 'Remove'}
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
      <p className='eyebrow m-0'>{groupId ? 'Edit group' : 'New group'}</p>

      <Section title='Details'>
        <Field label='Name'>
          <input
            type='text'
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className='input-field'
            placeholder='e.g. PIWC Stream Leaders'
            autoFocus
          />
        </Field>
        <Field label='Description (optional)'>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className='input-field'
            placeholder='What is this group for?'
            rows={3}
            style={{ resize: 'vertical' }}
          />
        </Field>
      </Section>

      {error && <ErrorBox>{error}</ErrorBox>}

      <div className='flex gap-3'>
        <button type='button' onClick={onCancel}
          className='flex-1 py-3 font-semibold text-sm cursor-pointer'
          style={{ background: 'var(--bg2)', border: '1.5px solid var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-btn)' }}>
          Cancel
        </button>
        <button type='submit' disabled={saving || !name.trim()}
          className='flex-1 btn-pill btn-primary py-3 font-semibold text-sm cursor-pointer disabled:opacity-50'>
          {saving ? 'Saving…' : groupId ? 'Save changes' : 'Create group'}
        </button>
      </div>
    </form>
  )
}

// ─── memberLeadsLabel ─────────────────────────────────────────────────────────
// Returns the most specific "leads X" label from a graph member object.
function memberLeadsLabel(m: any): string {
  const pick = (arr: any[]) => (Array.isArray(arr) && arr[0]?.name) ? arr[0].name : null
  return (
    pick(m.leadsBacenta)       && `Leads Bacenta · ${pick(m.leadsBacenta)}`       ||
    pick(m.leadsGovernorship)  && `Leads Governorship · ${pick(m.leadsGovernorship)}`  ||
    pick(m.leadsCouncil)       && `Leads Council · ${pick(m.leadsCouncil)}`       ||
    pick(m.leadsStream)        && `Leads Stream · ${pick(m.leadsStream)}`         ||
    pick(m.leadsCampus)        && `Leads Campus · ${pick(m.leadsCampus)}`         ||
    pick(m.leadsOversight)     && `Leads Oversight · ${pick(m.leadsOversight)}`   ||
    pick(m.leadsDenomination)  && `Leads Denomination · ${pick(m.leadsDenomination)}` ||
    pick(m.isAdminForCouncil)  && `Admin · ${pick(m.isAdminForCouncil)}`          ||
    pick(m.isAdminForStream)   && `Admin · ${pick(m.isAdminForStream)}`           ||
    pick(m.isAdminForCampus)   && `Admin · ${pick(m.isAdminForCampus)}`           ||
    pick(m.isAdminForOversight)&& `Admin · ${pick(m.isAdminForOversight)}`        ||
    ''
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
      <label className='text-xs font-bold uppercase tracking-widest' style={{ color: 'var(--muted)' }}>{label}</label>
      {children}
    </div>
  )
}

function ErrorBox({ children }) {
  return (
    <div className='p-3 text-sm' style={{ background: 'color-mix(in oklab, var(--absent) 10%, transparent)', color: 'var(--coral)', border: '1px solid color-mix(in oklab, var(--absent) 20%, transparent)', borderRadius: 'var(--radius-btn)' }}>
      {children}
    </div>
  )
}

function SearchDropdown({ children }) {
  return (
    <div
      style={{
        position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 100,
        background: 'var(--card)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-btn)', maxHeight: 300, overflowY: 'auto',
        boxShadow: 'var(--shadow-2)',
      }}
    >
      {children}
    </div>
  )
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
      className='w-full text-left px-3 py-2 cursor-pointer flex items-center gap-3'
      style={{
        background: 'transparent', border: 'none', borderBottom: '1px solid var(--border)',
        color: disabled ? 'var(--muted)' : 'var(--text)', fontFamily: 'var(--sans)',
        opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer',
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = 'var(--bg2)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      {/* Avatar */}
      <div className='shrink-0' style={{ width: 32, height: 32, borderRadius: '50%', overflow: 'hidden', background: 'var(--bg2)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {pictureUrl
          ? <img src={pictureUrl} alt={label} width={32} height={32} style={{ objectFit: 'cover', width: '100%', height: '100%' }} />
          : <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)' }}>{initials}</span>
        }
      </div>
      <div className='min-w-0'>
        <div className='text-sm font-semibold truncate'>{label}</div>
        {sublabel && <div className='text-xs truncate' style={{ color: 'var(--muted)', marginTop: 1 }}>{sublabel}</div>}
      </div>
    </button>
  )
}
