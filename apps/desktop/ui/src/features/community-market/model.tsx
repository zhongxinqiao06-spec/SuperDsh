import { IconCordisPluginOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  PropsLocale,
  PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {
  MarketCatalogResponse,
  MarketCatalogSourceResult,
  MarketInstallableResponse,
  MarketInstallationView,
  MarketOperationPreviewResponse,
  MarketSourceView,
} from '@superdsh/core/contracts/community-market/api-types'
import type { CatalogSnapshot } from '@superdsh/core/contracts/community-market/generated/catalog-snapshot'
import { marketMediaAssetUrl } from '@superdsh/core/contracts/community-market/media-ref'

export type MarketItem = CatalogSnapshot['items'][number]

export type MarketView = 'discover' | 'installable' | 'installed' | 'sources'

export const INSTALL_REQUIREMENTS_DOCS = {
  en: 'https://github.com/anywhere-labs/deepseek-harness-desktop/blob/master/dsh-community-market/docs/install-and-uninstall.md',
  zh: 'https://github.com/anywhere-labs/deepseek-harness-desktop/blob/master/dsh-community-market/docs/install-and-uninstall.zh.md',
} as const

export const CATALOG_ADAPTER_GUIDE_DOCS = {
  en: 'https://github.com/anywhere-labs/deepseek-harness-desktop/blob/master/dsh-community-market/docs/catalog-adapter-guide.md',
  zh: 'https://github.com/anywhere-labs/deepseek-harness-desktop/blob/master/dsh-community-market/docs/catalog-adapter-guide.zh.md',
} as const

export const DSH_DESKTOP_ISSUES_URL =
  'https://github.com/anywhere-labs/deepseek-harness-desktop/issues'

export function installRequirementsUrl(locale: string): string {
  return locale.toLowerCase().startsWith('zh')
    ? INSTALL_REQUIREMENTS_DOCS.zh
    : INSTALL_REQUIREMENTS_DOCS.en
}

export function catalogAdapterGuideUrl(locale: string): string {
  return locale.toLowerCase().startsWith('zh')
    ? CATALOG_ADAPTER_GUIDE_DOCS.zh
    : CATALOG_ADAPTER_GUIDE_DOCS.en
}

export interface VisibleItem {
  readonly item: MarketItem
  readonly source: MarketSourceView
  readonly stale: boolean
}

export interface CompletedOperation {
  readonly preview: MarketOperationPreviewResponse
  readonly restartToken: string
}

export type ManualInstallHint = MarketCatalogResponse['manualInstall'][number]

export type InstallationLoadOutcome =
  | { readonly installations: readonly MarketInstallationView[] }
  | { readonly error: string }

export function visibleItemKey(value: VisibleItem): string {
  return `${value.source.sourceRecordId}\0${value.source.providerId}\0${value.item.id}\0${value.item.package?.name ?? ''}`
}

export function matchingInstallation(
  value: VisibleItem,
  installations: readonly MarketInstallationView[],
): MarketInstallationView | undefined {
  const packageName = value.item.package?.name
  if (packageName === undefined) return undefined
  const matches = installations.filter(
    (installation) => installation.packageName === packageName,
  )
  return matches.length === 1 ? matches[0] : undefined
}

export function isDesktopUnavailable(cause: unknown): boolean {
  return (
    cause !== null &&
    typeof cause === 'object' &&
    'status' in cause &&
    (cause as { status?: unknown }).status === 503
  )
}

export function operationErrorMessage(
  cause: unknown,
  fallback: string,
): string {
  return cause instanceof Error && cause.message.trim().length > 0
    ? cause.message
    : fallback
}

export function operationErrorDetails(cause: unknown): string | undefined {
  const details =
    cause !== null && typeof cause === 'object' && 'details' in cause
      ? (cause as { readonly details?: unknown }).details
      : undefined
  return typeof details === 'string' && details.trim().length > 0
    ? details
    : undefined
}

export function catalogFailureMessage(
  cause: unknown,
  source: MarketSourceView,
  t: MarketSettingsTabProps['t'],
): string {
  const code =
    cause !== null && typeof cause === 'object' && 'code' in cause
      ? (cause as { code?: unknown }).code
      : undefined
  const reason =
    code === 'catalog-timeout'
      ? t('catalogFailureTimeout')
      : code === 'catalog-invalid-response'
        ? t('catalogFailureInvalidResponse')
        : t('catalogFailureUnavailable')
  return `${t('catalogFailureSource')}: ${source.name}. ${reason}`
}

export function PluginIcon({
  item,
  large = false,
}: {
  item: MarketItem
  large?: boolean
}) {
  const icon = item.media?.icon
  return (
    <div
      className={
        large ? 'dshMarketGlyph dshMarketGlyphLarge' : 'dshMarketGlyph'
      }
    >
      <IconCordisPluginOutlineRegular size={large ? 28 : 20} />
      {icon !== undefined && (
        <img
          src={marketMediaAssetUrl(icon.assetRef)}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={(event) => {
            event.currentTarget.remove()
          }}
        />
      )}
    </div>
  )
}

export type MarketSettingsTabProps = PropsRuntime<'settings.plugins.tab'> &
  PropsLocale<'community-market'> & {
    readLocale: () => string
    initialView?: MarketView
  }

export interface MarketSurfaceProps {
  readonly readLocale: () => string
  readonly t: MarketSettingsTabProps['t']
  readonly showHeader?: boolean
  readonly initialView?: MarketView
}

export function retainEnabledCatalog(
  catalog: MarketCatalogResponse | undefined,
  sources: readonly MarketSourceView[],
): MarketCatalogResponse | undefined {
  if (catalog === undefined) return undefined
  const selected = [...sources]
    .filter((source) => source.enabled)
    .sort((left, right) => left.order - right.order)
    .at(0)
  if (selected === undefined) return undefined
  const result = catalog.results.find(
    (value) => value.source.sourceRecordId === selected.sourceRecordId,
  )
  return result === undefined
    ? undefined
    : { ...catalog, results: [{ ...result, source: selected }] }
}

export function selectedSource(
  sources: readonly MarketSourceView[],
): MarketSourceView | undefined {
  return [...sources]
    .filter((source) => source.enabled)
    .sort((left, right) => left.order - right.order)
    .at(0)
}

export function mergeCatalogPages(
  catalog: MarketCatalogResponse | undefined,
  pages: readonly MarketCatalogSourceResult[],
  manualInstall: readonly ManualInstallHint[],
): MarketCatalogResponse | undefined {
  if (catalog === undefined || pages.length === 0) return catalog
  const updates = new Map(
    pages.map((page) => [page.source.sourceRecordId, page]),
  )
  const results = catalog.results.map((current) => {
    const next = updates.get(current.source.sourceRecordId)
    if (current.snapshot === undefined || next?.snapshot === undefined)
      return current
    const seen = new Set<string>()
    const items = [...current.snapshot.items, ...next.snapshot.items].filter(
      (item) => {
        if (seen.has(item.id)) return false
        seen.add(item.id)
        return true
      },
    )
    return {
      ...next,
      source: current.source,
      snapshot: { ...next.snapshot, items, page: next.snapshot.page },
    }
  })
  const hints = new Map(
    [...catalog.manualInstall, ...manualInstall].map((hint) => [
      `${hint.sourceRecordId}:${hint.itemId}`,
      hint,
    ]),
  )
  return {
    ...catalog,
    results,
    manualInstall: [...hints.values()],
    fetchedAt: new Date().toISOString(),
  }
}

export function mergeInstallablePages(
  current: MarketInstallableResponse | undefined,
  next: MarketInstallableResponse,
): MarketInstallableResponse {
  if (
    current === undefined ||
    current.source.sourceRecordId !== next.source.sourceRecordId
  )
    return next
  const seen = new Set<string>()
  const items = [...current.items, ...next.items].filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
  const hints = new Map(
    [...current.manualInstall, ...next.manualInstall].map((hint) => [
      `${hint.sourceRecordId}:${hint.itemId}`,
      hint,
    ]),
  )
  return {
    ...next,
    items,
    categories:
      next.categories.length === 0 ? current.categories : next.categories,
    manualInstall: [...hints.values()],
  }
}
