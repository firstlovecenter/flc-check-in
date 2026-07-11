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
  /** When true, fills the full viewport. Default: true. */
  fullPage?: boolean
  size?: number
  /** Optional status line under the icon (e.g. "Loading event details."). */
  message?: string
}

export default function Spinner({ fullPage = true, size = 48, message }: SpinnerProps) {
  const body = (
    <div className='flex flex-col items-center gap-4 px-6' role='status' aria-live='polite'>
      <img
        src='/synago-logo.svg'
        alt=''
        aria-hidden='true'
        width={size}
        height={size}
        className='synago-spin'
      />
      {message && (
        <p className='m-0 max-w-xs text-center text-sm font-medium text-muted-foreground'>
          {message}
        </p>
      )}
    </div>
  )

  if (fullPage) {
    return (
      <>
        <style>{SPIN_CSS}</style>
        <div className='page-shell fixed inset-0 z-10 flex items-center justify-center'>
          {body}
        </div>
      </>
    )
  }

  return (
    <>
      <style>{SPIN_CSS}</style>
      <div className='flex items-center justify-center p-6'>{body}</div>
    </>
  )
}
