const SPIN_CSS = `
@keyframes synagoSpin {
  from { transform: rotate(0deg); }
  33%  { transform: rotate(30deg); }
  50%  { transform: rotate(120deg); }
  83%  { transform: rotate(150deg); }
  to   { transform: rotate(240deg); }
}
.synago-spin { animation: synagoSpin 1.8s cubic-bezier(0.4,0,0.6,1) infinite; display: block; }
`

interface SpinnerProps {
  /** When true, fills the full viewport. Default: false (inline centred block). */
  fullPage?: boolean
  size?: number
}

export default function Spinner({ fullPage = true, size = 48 }: SpinnerProps) {
  const img = (
    <img
      src='/synago-logo.svg'
      alt=''
      aria-hidden='true'
      width={size}
      height={size}
      className='synago-spin'
    />
  )

  if (fullPage) {
    return (
      <>
        <style>{SPIN_CSS}</style>
        <div
          style={{
            position: 'fixed', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--bg)',
            zIndex: 10,
          }}
        >
          {img}
        </div>
      </>
    )
  }

  return (
    <>
      <style>{SPIN_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
        {img}
      </div>
    </>
  )
}
