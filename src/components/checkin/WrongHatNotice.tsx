import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation()
  const { focusedHat, isMultiRole } = useChurchFocus()

  return (
    <CenterCard>
      <div className='flex flex-col gap-4 text-center'>
        <div>
          <h2 className='mb-1 text-lg font-semibold text-foreground'>
            {t('checkin.wrongHat.title')}
          </h2>
          <p className='m-0 text-sm text-muted-foreground'>
            {scopeChurchName
              ? t('checkin.wrongHat.belongsTo', { name: scopeChurchName })
              : t('checkin.wrongHat.belongsElsewhere')}
            {focusedHat && <> {t('checkin.wrongHat.actingAs', { role: focusedHat.roleLabel })}</>}
          </p>
        </div>

        {isMultiRole ? (
          <>
            <p className='m-0 text-sm text-muted-foreground'>
              {t('checkin.wrongHat.switchRole')}
            </p>
            <div className='flex justify-center'>
              <ChurchScopeSwitcher />
            </div>
          </>
        ) : (
          <p className='m-0 text-sm text-muted-foreground'>
            {t('checkin.wrongHat.askAdmin')}
          </p>
        )}

        <Link to='/home' className='btn-pill btn-secondary w-full text-center no-underline'>
          {t('checkin.backHome')}
        </Link>
      </div>
    </CenterCard>
  )
}
