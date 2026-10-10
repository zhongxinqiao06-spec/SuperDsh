import type { FormEvent } from 'react'
import type {
  DesktopProfileView,
  DesktopSettingsView,
} from '@superdsh/core/client/desktop-settings-api'
import { Choice } from './DesktopSettingsControls.tsx'
import type {
  Translate,
  BusyOperation,
  RestartState,
} from './desktop-settings-types.ts'

function profileState(profile: DesktopProfileView, t: Translate): string {
  if (!profile.exists || !profile.webCapable || !profile.selectable)
    return t('profileUnavailable')
  return t('profileReady')
}

export function DesktopProfilesSection({
  t,
  view,
  busy,
  restart,
  loadFailed,
  load,
  profileName,
  setProfileName,
  pendingProfileDelete,
  setPendingProfileDelete,
  createProfile,
  selectProfile,
  deleteProfile,
}: {
  t: Translate
  view: DesktopSettingsView | undefined
  busy: BusyOperation | undefined
  restart: RestartState
  loadFailed: boolean
  load: () => Promise<void>
  profileName: string
  setProfileName: (value: string) => void
  pendingProfileDelete: string | undefined
  setPendingProfileDelete: (value: string | undefined) => void
  createProfile: (event: FormEvent) => void
  selectProfile: (name: string) => void
  deleteProfile: (name: string) => void
}) {
  return (
    <section
      className="dshDesktopSettingsGroup"
      aria-labelledby="dsh-desktop-profile-title"
    >
      <div>
        <h3 id="dsh-desktop-profile-title">{t('profileTitle')}</h3>
        <p className="dshDesktopSettingsGroupIntro">{t('profileIntro')}</p>
      </div>
      {busy === 'load' && view === undefined && (
        <p className="dshDesktopSettingsHint">{t('loading')}</p>
      )}
      {loadFailed && view === undefined && (
        <div>
          <p className="dshDesktopSettingsError" role="alert">
            {t('unavailable')}
          </p>
          <button
            type="button"
            className="dshDesktopSettingsButton"
            onClick={() => {
              void load()
            }}
          >
            {t('retry')}
          </button>
        </div>
      )}
      {view !== undefined && (
        <>
          <div
            className="dshDesktopSettingsList"
            role="radiogroup"
            aria-labelledby="dsh-desktop-profile-title"
          >
            {view.profiles.map((profile) => {
              const current = profile.name === view.current
              const deleteAction =
                profile.deletable &&
                !current &&
                busy === undefined &&
                restart === 'none' ? (
                  <div
                    className="dshDesktopSettingsChoiceAside"
                    onClick={(event) => {
                      event.stopPropagation()
                    }}
                  >
                    {pendingProfileDelete === profile.name ? (
                      <div
                        className="dshDesktopSettingsDeleteConfirm"
                        role="group"
                        aria-label={t('confirmDeleteProfile')}
                      >
                        <span className="dshDesktopSettingsDeleteWarning">
                          {t('deleteProfileWarning')}
                        </span>
                        <span className="dshDesktopSettingsDeleteActions">
                          <button
                            type="button"
                            className="dshDesktopSettingsButton dshDesktopSettingsButtonDanger"
                            disabled={busy !== undefined}
                            onClick={() => {
                              deleteProfile(profile.name)
                            }}
                          >
                            {busy === 'delete-profile'
                              ? t('deletingProfile')
                              : t('confirmDeleteProfile')}
                          </button>
                          <button
                            type="button"
                            className="dshDesktopSettingsButton dshDesktopSettingsButtonSecondary"
                            disabled={busy !== undefined}
                            onClick={() => {
                              setPendingProfileDelete(undefined)
                            }}
                          >
                            {t('cancelDeleteProfile')}
                          </button>
                        </span>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="dshDesktopSettingsButton dshDesktopSettingsButtonSecondary"
                        onClick={() => {
                          setPendingProfileDelete(profile.name)
                        }}
                      >
                        {t('deleteProfile')}
                      </button>
                    )}
                  </div>
                ) : undefined
              return (
                <Choice
                  key={profile.name}
                  title={profile.name}
                  body={profileState(profile, t)}
                  selected={current}
                  disabled={
                    !profile.selectable ||
                    busy !== undefined ||
                    restart !== 'none'
                  }
                  action={() => {
                    selectProfile(profile.name)
                  }}
                  status={current ? t('activeProfile') : undefined}
                  aside={deleteAction}
                />
              )
            })}
          </div>
          <form className="dshDesktopSettingsForm" onSubmit={createProfile}>
            <label className="dshDesktopSettingsField">
              {t('profileName')}
              <input
                className="dshDesktopSettingsInput"
                value={profileName}
                maxLength={128}
                autoComplete="off"
                placeholder={t('profileNamePlaceholder')}
                disabled={busy !== undefined || restart !== 'none'}
                onChange={(event) => {
                  setProfileName(event.currentTarget.value)
                }}
              />
            </label>
            <button
              type="submit"
              className="dshDesktopSettingsButton"
              disabled={
                profileName.trim().length === 0 ||
                busy !== undefined ||
                restart !== 'none'
              }
            >
              {busy === 'create-profile' ? t('creatingProfile') : t('create')}
            </button>
          </form>
        </>
      )}
    </section>
  )
}
