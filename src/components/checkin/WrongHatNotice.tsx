import { Link } from 'react-router-dom'
import { CenterCard } from '../layout/CenterCard'
import { useChurchFocus } from '../../contexts/ChurchFocusContext'
import ChurchScopeSwitcher from '../ChurchScopeSwitcher'

/**
 * Shown when the hat the user is wearing grants nothing on this event.
 *
 * Before the role model this state did not exist — a user with several roles
 * saw a merged view and simply got whatever the max-of-all-roles heuristic
 * decided, right or wrong. Now that exactly one role is active, "you can't see
 * this as a Bacenta Leader, but you can as a Stream Admin" is a real and
 * common situation, and it needs to be a signpost rather than a dead end.
 *
 * Users with only one role can't switch, so they get a plain explanation
 * instead of a control that would do nothing.
 */
export default function WrongHatNotice({ scopeChurchName }: { scopeChurchName?: string | null }) {
  const { focusedHat, isMultiRole } = useChurchFocus()

  return (
    <CenterCard>
      <div className='flex flex-col gap-4 text-center'>
        <div>
          <h2 className='mb-1 text-lg font-semibold text-foreground'>
            Not visible with this role
          </h2>
          <p className='m-0 text-sm text-muted-foreground'>
            {scopeChurchName
              ? <>This event belongs to <strong>{scopeChurchName}</strong>.</>
              : 'This event belongs to another part of the church.'}
            {focusedHat && <> You&apos;re acting as <strong>{focusedHat.roleLabel}</strong>.</>}
          </p>
        </div>

        {isMultiRole ? (
          <>
            <p className='m-0 text-sm text-muted-foreground'>
              Switch to a role that covers it:
            </p>
            <div className='flex justify-center'>
              <ChurchScopeSwitcher />
            </div>
          </>
        ) : (
          <p className='m-0 text-sm text-muted-foreground'>
            If you should have access, ask your administrator to check your role.
          </p>
        )}

        <Link to='/home' className='btn-pill btn-secondary w-full text-center no-underline'>
          Back to Home
        </Link>
      </div>
    </CenterCard>
  )
}
