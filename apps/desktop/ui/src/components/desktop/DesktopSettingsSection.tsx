/** Desktop settings orchestration; forms and controls live in adjacent views. */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopSettingsForm } from './settings-bridge.ts'
import type {
  DesktopMarketProvider,
  DesktopSettingsView,
} from '@superdsh/core/client/desktop-settings-api'
import {
  changeDesktopProfile,
  isAbortError,
  readDesktopSettingsUntilLanSettled,
  persistDesktopBrowserAccessHot,
  persistDesktopNetworkExposureHot,
} from '@superdsh/core/client/desktop-settings-operations'
import {
  desktopBrowserAccessAvailable,
  desktopBrowserAccessEnabled,
} from '@superdsh/core/contracts/desktop-ui'
import type {
  DesktopShellSettings,
  DesktopNotificationSettings,
} from '@superdsh/core/contracts/desktop-settings'
import type { DesktopSettingsLocaleKey } from './desktop-settings-locales.ts'
import type {
  DesktopSettingsSectionInjected,
  BusyOperation,
  RestartState,
} from './desktop-settings-types.ts'
import {
  Choice,
  DesktopSettingsToggleRow,
  DesktopBrowserUrl,
  MARKET_OPTIONS,
  marketTitle,
  marketBody,
} from './DesktopSettingsControls.tsx'
import { DesktopProfilesSection } from './DesktopProfilesSection.tsx'
export type {
  DesktopSettingsSectionInjected,
  DesktopSettingsSectionProps,
} from './desktop-settings-types.ts'
export {
  Choice,
  DesktopSettingsToggleRow,
  MARKET_OPTIONS,
  marketTitle,
  marketBody,
} from './DesktopSettingsControls.tsx'

const LAN_STATE_LOCALE_KEYS = {
  inactive: 'lanStatusInactive',
  starting: 'lanStatusStarting',
  ready: 'lanStatusReady',
  failed: 'lanStatusFailed',
} as const satisfies Record<
  DesktopSettingsView['web']['lanState'],
  DesktopSettingsLocaleKey
>

/** URLs are advertised only after the user explicitly enables browser access. */
export function desktopBrowserUrlsShouldRender(
  browserAccess: boolean,
  _networkExposure: DesktopShellSettings['networkExposure'],
): boolean {
  return browserAccess
}

/** Keep cancellation side-effect free; only explicit confirmation enables LAN. */
export function resolveDesktopLanConfirmation(
  confirmed: boolean,
  dismiss: () => void,
  enableLan: () => void,
): void {
  dismiss()
  if (confirmed) enableLan()
}

function useScope<T>(
  scope: Pick<DesktopSettingsForm<T>, 'getSnapshot' | 'subscribe'>,
) {
  const subscribe = useCallback(
    (listener: () => void) => scope.subscribe(listener),
    [scope],
  )
  const snapshot = useCallback(() => scope.getSnapshot(), [scope])
  return useSyncExternalStore(subscribe, snapshot)
}

/** Render the Desktop settings page. */
export function DesktopSettingsSection({
  t,
  api,
  platform,
  version,
  initialMode,
  micaSupported,
  setMode: persistMode,
  desktopSettings,
  notificationSettings,
  capabilities,
  introNotice,
  browserActions,
  extraSections,
}: DesktopSettingsSectionInjected &
  Pick<PropsLocale<'desktop.settings'>, 't'>) {
  const desktop = useScope(desktopSettings)
  const notifications = useScope(notificationSettings)
  const [view, setView] = useState<DesktopSettingsView>()
  const [profileName, setProfileName] = useState('')
  const [busy, setBusy] = useState<BusyOperation | undefined>('load')
  const [loadFailed, setLoadFailed] = useState(false)
  const [operationFailed, setOperationFailed] = useState(false)
  const [aaStatus, setAaStatus] = useState<
    'idle' | 'saving' | 'failed' | 'saved'
  >('idle')
  const [restart, setRestart] = useState<RestartState>('none')
  const [pendingProfileDelete, setPendingProfileDelete] = useState<string>()
  const [confirmLan, setConfirmLan] = useState(false)
  const [updateCheck, setUpdateCheck] = useState<
    'idle' | 'checking' | 'failed'
  >('idle')
  const lanPoll = useRef<AbortController>()

  const refreshView = useCallback(async () => {
    lanPoll.current?.abort()
    const controller = new AbortController()
    lanPoll.current = controller
    try {
      return await readDesktopSettingsUntilLanSettled(
        api,
        setView,
        controller.signal,
      )
    } finally {
      if (lanPoll.current === controller) lanPoll.current = undefined
    }
  }, [api])

  const load = useCallback(async () => {
    setBusy('load')
    setLoadFailed(false)
    setOperationFailed(false)
    try {
      await refreshView()
    } catch (cause) {
      if (!isAbortError(cause)) setLoadFailed(true)
    } finally {
      setBusy((current) => (current === 'load' ? undefined : current))
    }
  }, [refreshView])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(
    () => () => {
      lanPoll.current?.abort()
    },
    [],
  )
  useEffect(() => {
    if (restart !== 'restarting') return
    const timer = setTimeout(() => {
      setRestart('required')
    }, 8_000)
    return () => {
      clearTimeout(timer)
    }
  }, [restart])

  const run = useCallback(
    async (operation: BusyOperation, invoke: () => Promise<void>) => {
      setBusy(operation)
      setOperationFailed(false)
      if (operation !== 'select-aa') setAaStatus('idle')
      try {
        await invoke()
      } catch {
        setOperationFailed(true)
      } finally {
        setBusy((current) => (current === operation ? undefined : current))
      }
    },
    [],
  )

  const requestRestart = (): void => {
    setRestart('restarting')
  }
  const settingsWritable = desktop.status === 'ready' && desktop.writable
  const notificationsWritable =
    notifications.status === 'ready' && notifications.writable
  const storedMode = desktop.value?.mode ?? initialMode
  const configuredNetworkExposure = desktop.value?.networkExposure ?? 'loopback'
  const browserAccess = desktopBrowserAccessEnabled(
    storedMode,
    desktop.value?.openBrowser ?? false,
    configuredNetworkExposure,
  )
  const mode = storedMode
  const networkExposure = browserAccess ? configuredNetworkExposure : 'loopback'
  const notificationValue = notifications.value ?? {
    enabled: true,
    notifyOnTurnCompletion: true,
    notifyOnTurnFailure: true,
    notifyOnJobCompletion: true,
    notifyOnJobFailure: true,
  }

  const profileOperation = (
    kind: 'create' | 'select' | 'delete',
    name: string,
  ): void => {
    void run(
      kind === 'create'
        ? 'create-profile'
        : kind === 'select'
          ? 'select-profile'
          : 'delete-profile',
      async () => {
        const result = await changeDesktopProfile(
          api,
          { kind, name },
          refreshView,
        )
        if (result.status === 'restart-required') requestRestart()
        if (result.status === 'updated') {
          setView(result.view)
          if (kind === 'create') setProfileName('')
          if (kind === 'delete') setPendingProfileDelete(undefined)
        }
      },
    )
  }
  const createProfile = (event: FormEvent): void => {
    event.preventDefault()
    profileOperation('create', profileName)
  }
  const selectProfile = (name: string): void => {
    profileOperation('select', name)
  }
  const deleteProfile = (name: string): void => {
    profileOperation('delete', name)
  }

  const selectAa = (enabled: boolean): void => {
    setAaStatus('saving')
    void run('select-aa', async () => {
      try {
        if (!api.selectAa) throw new Error('AA selection is unavailable')
        const response = await api.selectAa(enabled)
        setView((current) =>
          current === undefined
            ? current
            : {
                ...current,
                aa: {
                  requested: enabled,
                  effective: current.aa?.effective ?? false,
                },
              },
        )
        setAaStatus('saved')
        if (response.restartRequired) requestRestart()
        else setView(await refreshView())
      } catch (cause) {
        setAaStatus('failed')
        throw cause
      }
    })
  }

  const selectMarket = (provider: DesktopMarketProvider): void => {
    void run('select-market', async () => {
      const response = await api.selectMarket(provider)
      setView((current) =>
        current === undefined
          ? current
          : {
              ...current,
              market: {
                requested: provider,
                effective: current.market.effective,
                legacyDefaulted: false,
              },
            },
      )
      if (response.restartRequired) requestRestart()
      else setView(await refreshView())
    })
  }

  const openBrowser = (
    event: React.MouseEvent<HTMLAnchorElement>,
    url: string,
  ): void => {
    if (!api.openBrowser) return
    event.preventDefault()
    void run('web', () => api.openBrowser!(url))
  }

  const setMode = (next: DesktopShellSettings['mode']): void => {
    void run('mode', async () => {
      await persistMode(next)
      requestRestart()
    })
  }

  const setMaterial = (next: string): void => {
    void run('material', async () => {
      if (platform === 'darwin') {
        if (next !== 'off' && next !== 'transparent') {
          throw new Error(
            `dsh-plugin-desktop: invalid macOS material ${JSON.stringify(next)}`,
          )
        }
        await desktopSettings.set('macosMaterial', next)
      } else if (platform === 'linux') {
        if (next !== 'off' && next !== 'transparent') {
          throw new Error(
            `dsh-plugin-desktop: invalid Linux material ${JSON.stringify(next)}`,
          )
        }
        await desktopSettings.set('linuxMaterial', next)
      } else if (platform === 'win32') {
        if (next !== 'off' && (next !== 'mica' || !micaSupported)) {
          throw new Error(
            `dsh-plugin-desktop: unavailable Windows material ${JSON.stringify(next)}`,
          )
        }
        await desktopSettings.set('windowsMaterial', next)
      }
      if (capabilities?.materialRequiresRestart !== false) requestRestart()
    })
  }

  const setNotification = (
    field: keyof DesktopNotificationSettings,
    checked: boolean,
  ): void => {
    void run('notification', async () => {
      await notificationSettings.set(field, checked)
    })
  }

  // The interactive update flow owns its own native dialogs and downloads, so it
  // stays outside the settings-scope busy state and reports only its own failures.
  const runUpdateCheck = (): void => {
    setUpdateCheck('checking')
    void api
      .checkForUpdates()
      .then(() => {
        setUpdateCheck('idle')
      })
      .catch(() => {
        setUpdateCheck('failed')
      })
  }

  const setBrowserAccess = (checked: boolean): void => {
    void run('web', async () => {
      if (checked) {
        if (!desktopBrowserAccessAvailable(mode)) return
        await persistDesktopBrowserAccessHot(
          desktopSettings,
          true,
          configuredNetworkExposure,
          refreshView,
        )
        return
      }
      await persistDesktopBrowserAccessHot(
        desktopSettings,
        false,
        configuredNetworkExposure,
        refreshView,
      )
    })
  }

  const setNetworkExposure = (
    exposure: DesktopShellSettings['networkExposure'],
  ): void => {
    void run('web', async () => {
      if (
        exposure === 'lan' &&
        (!desktopBrowserAccessAvailable(mode) || !browserAccess)
      )
        return
      await persistDesktopNetworkExposureHot(
        desktopSettings,
        exposure,
        refreshView,
      )
    })
  }

  return (
    <div className="dshDesktopSettings">
      <header className="dshDesktopSettingsHeader">
        <h2>{t('title')}</h2>
        <p>{t('intro')}</p>
      </header>

      {introNotice}
      {operationFailed && aaStatus !== 'failed' && (
        <p className="dshDesktopSettingsError" role="alert">
          {t('operationFailed')}
        </p>
      )}
      {restart !== 'none' && (
        <p className="dshDesktopSettingsSuccess" role="status">
          {t(restart === 'restarting' ? 'restarting' : 'restartRequired')}
        </p>
      )}

      <DesktopProfilesSection
        t={t}
        view={view}
        busy={busy}
        restart={restart}
        loadFailed={loadFailed}
        load={load}
        profileName={profileName}
        setProfileName={setProfileName}
        pendingProfileDelete={pendingProfileDelete}
        setPendingProfileDelete={setPendingProfileDelete}
        createProfile={createProfile}
        selectProfile={selectProfile}
        deleteProfile={deleteProfile}
      />

      {capabilities?.pluginSelectors !== false && (
        <>
          <section
            className="dshDesktopSettingsGroup"
            aria-labelledby="dsh-desktop-market-title"
          >
            <div>
              <h3 id="dsh-desktop-market-title">{t('marketTitle')}</h3>
              <p className="dshDesktopSettingsGroupIntro">{t('marketIntro')}</p>
            </div>
            {view?.market.legacyDefaulted === true && (
              <p className="dshDesktopSettingsNotice">
                {t('legacyMarketNotice')}
              </p>
            )}
            {view !== undefined &&
              view.market.requested !== view.market.effective &&
              restart === 'none' && (
                <p className="dshDesktopSettingsNotice" role="status">
                  {t('marketLoadFailed')}
                </p>
              )}
            {view !== undefined && (
              <div
                className="dshDesktopSettingsList"
                role="radiogroup"
                aria-labelledby="dsh-desktop-market-title"
              >
                {MARKET_OPTIONS.filter(
                  (option) =>
                    capabilities?.markets === undefined ||
                    capabilities.markets.includes(option.id),
                ).map((option) => (
                  <Choice
                    key={option.id}
                    title={marketTitle(option, t)}
                    badge={
                      option.id === 'community-market' ? t('beta') : undefined
                    }
                    body={marketBody(option, t)}
                    selected={view.market.requested === option.id}
                    reselectable={
                      view.market.requested === option.id &&
                      view.market.requested !== view.market.effective
                    }
                    disabled={
                      capabilities?.featuresReadOnly === true ||
                      busy !== undefined ||
                      restart !== 'none'
                    }
                    action={() => {
                      selectMarket(option.id)
                    }}
                    status={
                      view.market.requested === option.id &&
                      view.market.requested !== view.market.effective
                        ? t('retryMarket')
                        : view.market.requested === option.id
                          ? t('selected')
                          : undefined
                    }
                  />
                ))}
              </div>
            )}
          </section>

          <section
            className="dshDesktopSettingsGroup"
            aria-labelledby="dsh-desktop-aa-title"
          >
            <div>
              <h3 id="dsh-desktop-aa-title">{t('aaTitle')}</h3>
              <p className="dshDesktopSettingsGroupIntro">{t('aaIntro')}</p>
            </div>
            {view?.aa?.requested === true &&
              !view.aa.effective &&
              restart === 'none' && (
                <p className="dshDesktopSettingsNotice" role="status">
                  {t('aaLoadFailed')}
                </p>
              )}
            {aaStatus === 'saving' && (
              <p className="dshDesktopSettingsNotice" role="status">
                {t('aaSaving')}
              </p>
            )}
            {aaStatus === 'failed' && (
              <p className="dshDesktopSettingsError" role="alert">
                {t('aaSaveFailed')}
              </p>
            )}
            {aaStatus === 'saved' && (
              <p className="dshDesktopSettingsSuccess" role="status">
                {t(
                  restart === 'restarting'
                    ? 'restarting'
                    : restart === 'required'
                      ? 'restartRequired'
                      : 'aaSaved',
                )}
              </p>
            )}
            {view !== undefined && (
              <div
                className="dshDesktopSettingsList"
                role="radiogroup"
                aria-labelledby="dsh-desktop-aa-title"
              >
                {[false, true].map((enabled) => (
                  <Choice
                    key={String(enabled)}
                    title={t(enabled ? 'aaEnabled' : 'aaDisabled')}
                    badge={enabled ? t('beta') : undefined}
                    body={t(enabled ? 'aaEnabledBody' : 'aaDisabledBody')}
                    selected={(view.aa?.requested ?? false) === enabled}
                    reselectable={
                      enabled &&
                      view.aa?.requested === true &&
                      !view.aa.effective
                    }
                    disabled={
                      capabilities?.featuresReadOnly === true ||
                      busy !== undefined ||
                      restart !== 'none'
                    }
                    action={() => {
                      selectAa(enabled)
                    }}
                    status={
                      enabled &&
                      view.aa?.requested === true &&
                      !view.aa.effective
                        ? t('retryAa')
                        : (view.aa?.requested ?? false) === enabled
                          ? t('selected')
                          : undefined
                    }
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}

      <section
        className="dshDesktopSettingsGroup"
        aria-labelledby="dsh-desktop-presentation-title"
      >
        <div>
          <h3 id="dsh-desktop-presentation-title">{t('presentationTitle')}</h3>
          <p className="dshDesktopSettingsGroupIntro">
            {t('presentationIntro')}
          </p>
        </div>
        {desktop.status === 'unavailable' && (
          <p className="dshDesktopSettingsNotice">{t('readOnly')}</p>
        )}
        {capabilities?.windowModes !== false && (
          <div
            className="dshDesktopSettingsList"
            role="radiogroup"
            aria-labelledby="dsh-desktop-presentation-title"
          >
            <Choice
              title={t('compatibilityMode')}
              body={t('compatibilityModeBody')}
              selected={mode === 'compatibility'}
              disabled={
                !settingsWritable || busy !== undefined || restart !== 'none'
              }
              action={() => {
                setMode('compatibility')
              }}
              status={mode === 'compatibility' ? t('selected') : undefined}
            />
            <Choice
              title={t('extendedMode')}
              body={
                platform === 'linux'
                  ? t('extendedUnavailableLinux')
                  : t('extendedModeBody')
              }
              selected={mode === 'extended'}
              disabled={
                platform === 'linux' ||
                !settingsWritable ||
                busy !== undefined ||
                restart !== 'none'
              }
              action={() => {
                setMode('extended')
              }}
              status={mode === 'extended' ? t('selected') : undefined}
            />
            <Choice
              title={t('advancedMode')}
              body={
                platform === 'linux'
                  ? t('advancedUnavailableLinux')
                  : t('advancedModeBody')
              }
              selected={mode === 'advanced'}
              disabled={
                platform === 'linux' ||
                !settingsWritable ||
                busy !== undefined ||
                restart !== 'none'
              }
              action={() => {
                setMode('advanced')
              }}
              status={mode === 'advanced' ? t('selected') : undefined}
            />
          </div>
        )}
        {platform !== 'linux' && (
          <label className="dshDesktopSettingsMaterialField">
            <span className="dshDesktopSettingsMaterialCopy">
              <span className="dshDesktopSettingsChoiceTitle">
                {t('windowMaterial')}
              </span>
              <span className="dshDesktopSettingsChoiceBody">
                {t('windowMaterialBody')}
              </span>
            </span>
            <select
              className="dshDesktopSettingsSelect"
              value={
                platform === 'darwin'
                  ? (desktop.value?.macosMaterial ?? 'transparent')
                  : desktop.value?.windowsMaterial === 'acrylic' ||
                      (!micaSupported &&
                        desktop.value?.windowsMaterial === 'mica')
                    ? 'off'
                    : (desktop.value?.windowsMaterial ?? 'off')
              }
              disabled={
                !settingsWritable || busy !== undefined || restart !== 'none'
              }
              onChange={(event) => {
                setMaterial(event.currentTarget.value)
              }}
            >
              <option value="off">{t('windowMaterialOff')}</option>
              {platform === 'darwin' ? (
                <option value="transparent">
                  {t('windowMaterialTransparent')}
                </option>
              ) : (
                <>
                  {micaSupported && (
                    <option value="mica">{t('windowMaterialMica')}</option>
                  )}
                </>
              )}
            </select>
          </label>
        )}
      </section>

      <section
        className="dshDesktopSettingsGroup"
        aria-labelledby="dsh-desktop-web-title"
      >
        <div>
          <h3 id="dsh-desktop-web-title">{t('webTitle')}</h3>
          <p className="dshDesktopSettingsGroupIntro">{t('webIntro')}</p>
        </div>
        <DesktopSettingsToggleRow
          label={t('openBrowser')}
          checked={browserAccess}
          disabled={
            !desktopBrowserAccessAvailable(mode) ||
            !settingsWritable ||
            busy !== undefined
          }
          onChange={setBrowserAccess}
        />
        <p className="dshDesktopSettingsNotice">
          {t('browserCompatibilityNotice')}
        </p>
        <DesktopSettingsToggleRow
          label={t('lanAccess')}
          badge={t('beta')}
          checked={networkExposure === 'lan'}
          disabled={!browserAccess || !settingsWritable || busy !== undefined}
          onChange={(checked) => {
            if (checked && capabilities?.nativeLanConfirmation !== true)
              setConfirmLan(true)
            else if (checked) setNetworkExposure('lan')
            else setNetworkExposure('loopback')
          }}
        />
        {view !== undefined && (
          <div
            className="dshDesktopSettingsLanStatus"
            data-state={view.web.lanState}
            role="status"
          >
            <span className="dshDesktopSettingsChoiceTitle">
              {t('lanStatus')}
              <span className="dshDesktopSettingsBadge">
                {t(LAN_STATE_LOCALE_KEYS[view.web.lanState])}
              </span>
            </span>
            {view.web.lanError !== null && (
              <span className="dshDesktopSettingsChoiceBody">
                {t('lanError')}: <code>{view.web.lanError}</code>
              </span>
            )}
          </div>
        )}
        {desktopBrowserUrlsShouldRender(browserAccess, networkExposure) &&
          view !== undefined &&
          view.web.localUrl !== '' && (
            <div className="dshDesktopSettingsUrls">
              <span className="dshDesktopSettingsChoiceTitle">
                {t('browserUrls')}
              </span>
              <DesktopBrowserUrl
                key={view.web.localUrl}
                url={view.web.localUrl}
                api={api}
                t={t}
                onOpen={(event) => openBrowser(event, view.web.localUrl)}
              />
              {view.web.lanUrls.length > 0 && (
                <span className="dshDesktopSettingsChoiceTitle">
                  {t('lanHttpsUrls')}
                </span>
              )}
              {view.web.lanUrls.map((url) => (
                <DesktopBrowserUrl
                  key={url}
                  url={url}
                  api={api}
                  t={t}
                  onOpen={(event) => openBrowser(event, url)}
                />
              ))}
            </div>
          )}
        {browserActions}
        {networkExposure === 'lan' && view !== undefined && (
          <>
            <p className="dshDesktopSettingsNotice">{t('lanTrustNotice')}</p>
            {(view.web.lanCaFingerprint !== null ||
              view.web.lanCaUrls.length > 0) && (
              <div className="dshDesktopSettingsUrls">
                <span className="dshDesktopSettingsChoiceTitle">
                  {t('lanCaTitle')}
                </span>
                {view.web.lanCaFingerprint !== null && (
                  <span className="dshDesktopSettingsLanFingerprint">
                    {t('lanCaFingerprint')}:{' '}
                    <code>{view.web.lanCaFingerprint}</code>
                  </span>
                )}
                {view.web.lanCaUrls.length > 0 && (
                  <span className="dshDesktopSettingsChoiceBody">
                    {t('lanCaDownloads')}
                  </span>
                )}
                {view.web.lanCaUrls.map((url) => (
                  <a
                    href={url}
                    key={url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {url}
                  </a>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      <section
        className="dshDesktopSettingsGroup"
        aria-labelledby="dsh-desktop-notifications-title"
      >
        <div>
          <h3 id="dsh-desktop-notifications-title">
            {t('notificationsTitle')}
          </h3>
          <p className="dshDesktopSettingsGroupIntro">
            {t('notificationsIntro')}
          </p>
        </div>
        {notifications.status === 'unavailable' && (
          <p className="dshDesktopSettingsNotice">{t('readOnly')}</p>
        )}
        <DesktopSettingsToggleRow
          label={t('notificationsEnabled')}
          checked={notificationValue.enabled}
          disabled={!notificationsWritable || busy !== undefined}
          onChange={(checked) => {
            setNotification('enabled', checked)
          }}
        />
        <div className="dshDesktopSettingsDetails">
          <DesktopSettingsToggleRow
            label={t('turnCompletion')}
            checked={notificationValue.notifyOnTurnCompletion}
            disabled={
              !notificationValue.enabled ||
              !notificationsWritable ||
              busy !== undefined
            }
            onChange={(checked) => {
              setNotification('notifyOnTurnCompletion', checked)
            }}
          />
          <DesktopSettingsToggleRow
            label={t('turnFailure')}
            checked={notificationValue.notifyOnTurnFailure}
            disabled={
              !notificationValue.enabled ||
              !notificationsWritable ||
              busy !== undefined
            }
            onChange={(checked) => {
              setNotification('notifyOnTurnFailure', checked)
            }}
          />
          {capabilities?.jobNotifications !== false && (
            <>
              <DesktopSettingsToggleRow
                label={t('jobCompletion')}
                checked={notificationValue.notifyOnJobCompletion}
                disabled={
                  !notificationValue.enabled ||
                  !notificationsWritable ||
                  busy !== undefined
                }
                onChange={(checked) => {
                  setNotification('notifyOnJobCompletion', checked)
                }}
              />
              <DesktopSettingsToggleRow
                label={t('jobFailure')}
                checked={notificationValue.notifyOnJobFailure}
                disabled={
                  !notificationValue.enabled ||
                  !notificationsWritable ||
                  busy !== undefined
                }
                onChange={(checked) => {
                  setNotification('notifyOnJobFailure', checked)
                }}
              />
            </>
          )}
        </div>
      </section>

      {capabilities?.updates !== false && (
        <section
          className="dshDesktopSettingsGroup"
          aria-labelledby="dsh-desktop-updates-title"
        >
          <div>
            <h3 id="dsh-desktop-updates-title">{t('updatesTitle')}</h3>
            <p className="dshDesktopSettingsGroupIntro">{t('updatesIntro')}</p>
          </div>
          <div className="dshDesktopSettingsUpdateRow">
            <span className="dshDesktopSettingsChoiceCopy">
              <span className="dshDesktopSettingsChoiceTitle">
                {t('currentVersion')}
              </span>
              <span className="dshDesktopSettingsChoiceBody">{`v${version}`}</span>
            </span>
            <button
              type="button"
              className="dshDesktopSettingsButton"
              disabled={updateCheck === 'checking'}
              onClick={runUpdateCheck}
            >
              {t(
                updateCheck === 'checking'
                  ? 'checkingForUpdates'
                  : 'checkForUpdates',
              )}
            </button>
          </div>
          {updateCheck === 'failed' && (
            <p className="dshDesktopSettingsError" role="alert">
              {t('checkForUpdatesError')}
            </p>
          )}
        </section>
      )}

      {extraSections}
      {confirmLan && (
        <div className="dshDesktopSettingsDialogBackdrop" role="presentation">
          <div
            className="dshDesktopSettingsDialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="dsh-desktop-lan-warning-title"
            aria-describedby="dsh-desktop-lan-warning-body"
          >
            <h3 id="dsh-desktop-lan-warning-title">{t('lanWarningTitle')}</h3>
            <p id="dsh-desktop-lan-warning-body">{t('lanWarningBody')}</p>
            <div className="dshDesktopSettingsDialogActions">
              <button
                type="button"
                className="dshDesktopSettingsButton dshDesktopSettingsButtonSecondary"
                onClick={() => {
                  resolveDesktopLanConfirmation(
                    false,
                    () => {
                      setConfirmLan(false)
                    },
                    () => {
                      setNetworkExposure('lan')
                    },
                  )
                }}
              >
                {t('lanCancel')}
              </button>
              <button
                type="button"
                className="dshDesktopSettingsButton dshDesktopSettingsButtonDanger"
                onClick={() => {
                  resolveDesktopLanConfirmation(
                    true,
                    () => {
                      setConfirmLan(false)
                    },
                    () => {
                      setNetworkExposure('lan')
                    },
                  )
                }}
              >
                {t('lanConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
