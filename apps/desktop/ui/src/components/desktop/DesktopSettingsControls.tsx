import { useEffect, useId, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import type {
  DesktopMarketProvider,
  DesktopSettingsApi,
} from '@superdsh/core/client/desktop-settings-api'
import type { DesktopSettingsLocaleKey } from './desktop-settings-locales.ts'
import type { Translate } from './desktop-settings-types.ts'

export function Choice({
  title,
  body,
  aside,
  selected,
  reselectable,
  disabled,
  action,
  status,
  badge,
}: {
  title: ReactNode
  body: ReactNode
  aside?: ReactNode
  selected: boolean
  reselectable?: boolean
  disabled?: boolean
  action: () => void
  status?: ReactNode
  badge?: ReactNode
}) {
  const actionable = disabled !== true && (!selected || reselectable === true)
  const choose = (): void => {
    if (actionable) action()
  }
  return (
    <div
      role="radio"
      className="dshDesktopSettingsChoice"
      data-selected={selected ? 'true' : undefined}
      data-actionable={actionable ? 'true' : undefined}
      aria-checked={selected}
      aria-disabled={disabled === true ? 'true' : undefined}
      tabIndex={disabled === true ? -1 : 0}
      onClick={choose}
      onKeyDown={(event) => {
        if (
          event.target !== event.currentTarget ||
          (event.key !== 'Enter' && event.key !== ' ')
        )
          return
        event.preventDefault()
        choose()
      }}
    >
      <span className="dshDesktopSettingsChoiceCopy">
        <span className="dshDesktopSettingsChoiceTitle">
          {title}
          {badge !== undefined && (
            <span className="dshDesktopSettingsBadge">{badge}</span>
          )}
          {status !== undefined && (
            <span className="dshDesktopSettingsBadge">{status}</span>
          )}
        </span>
        <span className="dshDesktopSettingsChoiceBody">{body}</span>
      </span>
      {aside}
    </div>
  )
}

function RepositoryLink({
  href,
  children,
}: {
  href: string
  children: ReactNode
}) {
  return (
    <a
      className="dshDesktopSettingsChoiceLink"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        event.stopPropagation()
      }}
    >
      {children}
    </a>
  )
}

export function DesktopSettingsToggleRow({
  label,
  badge,
  checked,
  disabled,
  onChange,
}: {
  label: ReactNode
  badge?: ReactNode
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  const labelId = useId()
  return (
    <div className="dshDesktopSettingsToggleRow">
      <span className="dshDesktopSettingsToggleLabel" id={labelId}>
        {label}
        {badge !== undefined && (
          <span className="dshDesktopSettingsBadge">{badge}</span>
        )}
      </span>
      <button
        type="button"
        role="switch"
        className="dshDesktopSettingsToggle"
        aria-checked={checked}
        aria-labelledby={labelId}
        disabled={disabled}
        onClick={() => {
          onChange(!checked)
        }}
      >
        <span className="dshDesktopSettingsToggleKnob" aria-hidden="true" />
      </button>
    </div>
  )
}

export const MARKET_OPTIONS: readonly {
  id: DesktopMarketProvider
  title: DesktopSettingsLocaleKey
  body: DesktopSettingsLocaleKey
}[] = [
  { id: 'disabled', title: 'marketDisabled', body: 'marketDisabledBody' },
  {
    id: 'community-market',
    title: 'communityMarket',
    body: 'communityMarketBody',
  },
  { id: 'dsh-market', title: 'dshMarket', body: 'dshMarketBody' },
]

const COMMUNITY_MARKET_URL =
  'https://github.com/anywhere-labs/deepseek-harness-desktop/tree/master/dsh-community-market'
const DSH_MARKET_URL = 'https://github.com/dsh-market/dsh-market'
const AWESOME_DSH_PLUGIN_URL =
  'https://github.com/awesome-dsh-plugin/awesome-dsh-plugin'

export function marketTitle(
  option: (typeof MARKET_OPTIONS)[number],
  t: Translate,
): ReactNode {
  if (option.id === 'community-market') {
    return (
      <RepositoryLink href={COMMUNITY_MARKET_URL}>
        {t(option.title)}
      </RepositoryLink>
    )
  }
  if (option.id === 'dsh-market') {
    return (
      <RepositoryLink href={DSH_MARKET_URL}>{t(option.title)}</RepositoryLink>
    )
  }
  return t(option.title)
}

export function marketBody(
  option: (typeof MARKET_OPTIONS)[number],
  t: Translate,
): ReactNode {
  if (option.id !== 'dsh-market') return t(option.body)
  return (
    <>
      {t(option.body)}{' '}
      <RepositoryLink href={AWESOME_DSH_PLUGIN_URL}>
        awesome-dsh-plugin
      </RepositoryLink>
    </>
  )
}

export function DesktopBrowserUrl({
  url,
  api,
  t,
  onOpen,
}: {
  url: string
  api: DesktopSettingsApi
  t: Translate
  onOpen: React.MouseEventHandler<HTMLAnchorElement>
}) {
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  const link = (
    <a href={url} onClick={onOpen} target="_blank" rel="noopener noreferrer">
      {url}
    </a>
  )
  if (!api.copyBrowser) return link
  const copy = async (): Promise<void> => {
    setBusy(true)
    setFailed(false)
    setCopied(false)
    try {
      await api.copyBrowser!(url)
      setCopied(true)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="dshDesktopSettingsUrlRow">
        {link}
        <button
          type="button"
          className="dshDesktopSettingsUrlCopy"
          disabled={busy}
          aria-label={`${t('copyBrowserUrl')} ${new URL(url).host}`}
          title={t(copied ? 'browserUrlCopied' : 'copyBrowserUrl')}
          onClick={() => {
            void copy()
          }}
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </div>
      {failed && (
        <p role="alert" className="dshDesktopSettingsError">
          {t('operationFailed')}
        </p>
      )}
    </>
  )
}
