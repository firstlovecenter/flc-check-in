import { useRegisterSW } from 'virtual:pwa-register/react'

export default function UpdatePrompt() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW()

  if (!needRefresh) return null

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '1.25rem',
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'calc(100% - 2rem)',
        maxWidth: '28rem',
        zIndex: 9999,
        background: 'var(--card)',
        border: '1.5px solid var(--border)',
        borderRadius: 'var(--radius-card, 16px)',
        padding: '1rem 1.25rem',
        display: 'flex',
        alignItems: 'center',
        gap: '1rem',
        boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
      }}
    >
      <div style={{ flex: 1 }}>
        <p className='text-sm font-semibold m-0' style={{ color: 'var(--text)' }}>
          Update available
        </p>
        <p className='text-xs m-0 mt-0.5' style={{ color: 'var(--muted)' }}>
          A new version of the app is ready.
        </p>
      </div>
      <button
        onClick={() => updateServiceWorker(true)}
        className='text-xs font-semibold px-4 py-2 cursor-pointer'
        style={{
          background: 'var(--accent)',
          color: '#fff',
          border: 'none',
          borderRadius: 'var(--radius-btn, 8px)',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        Refresh
      </button>
    </div>
  )
}
