import {
  Button,
  IconGlobeOutlineRegular,
  IconRefreshOutlineRegular,
  IconSearchOutlineRegular,
  IconSettingsOutlineRegular,
  IconTrashOutlineRegular,
  Input,
  Pill,
  StateDot,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  MarketCatalogResponse,
  MarketInstallableResponse,
  MarketInstallationView,
  MarketStateResponse,
} from '@superdsh/core/contracts/community-market/api-types'
import { PluginCard } from './card-components.js'
import { type MarketSettingsTabProps, type VisibleItem } from './model.js'

export function DiscoverView(props: {
  state?: MarketStateResponse | undefined
  items: readonly VisibleItem[]
  metadata: MarketCatalogResponse['metadata']
  query: string
  categoryOptions: readonly string[]
  selectedCategories: readonly string[]
  loading: boolean
  loadingMore: boolean
  mutationPending: boolean
  error?: string | undefined
  loadMoreError?: string | undefined
  partialFailure: boolean
  hasMore: boolean
  onQuery: (value: string) => void
  onSearch: () => void
  onRefresh: () => void
  onToggleCategory: (category: string) => void
  onLoadMore: () => void
  onSources: () => void
  onSelect: (value: VisibleItem) => void
  t: MarketSettingsTabProps['t']
}) {
  const noSources =
    props.state !== undefined &&
    !props.state.sources.some((source) => source.enabled)
  if (noSources)
    return (
      <div className="dshMarketEmpty">
        <div className="dshMarketEmptyIcon">
          <IconGlobeOutlineRegular size={24} />
        </div>
        <h2>{props.t('emptyTitle')}</h2>
        <p>{props.t('emptyBody')}</p>
        <Button
          variant="primary"
          icon={<IconSettingsOutlineRegular />}
          onClick={props.onSources}
        >
          {props.t('chooseSources')}
        </Button>
      </div>
    )
  return (
    <div className="dshMarketContent">
      {props.metadata !== undefined && (
        <div className="dshMarketIndexMeta" role="status">
          <span>
            {props.t('scannedAt')}: {props.metadata.scannedAt}
          </span>
          <span>
            {props.t('cacheExpiresAt')}: {props.metadata.expiresAt}
          </span>
          {props.metadata.providerRevision !== undefined && (
            <span>
              {props.t('providerRevision')}: {props.metadata.providerRevision}
            </span>
          )}
          <span>
            {props.metadata.cacheStatus === 'fresh'
              ? props.t('freshScan')
              : props.t('cachedScan')}
          </span>
        </div>
      )}
      <form
        className="dshMarketToolbar"
        onSubmit={(event) => {
          event.preventDefault()
          props.onSearch()
        }}
      >
        <Input
          className="dshMarketSearch"
          icon={<IconSearchOutlineRegular />}
          value={props.query}
          disabled={props.mutationPending}
          placeholder={props.t('search')}
          onChange={(event) => props.onQuery(event.currentTarget.value)}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={props.mutationPending}
          icon={<IconSearchOutlineRegular />}
        >
          {props.t('searchAction')}
        </Button>
        <Tooltip label={props.t('refresh')}>
          <Button
            type="button"
            size="sm"
            variant="toolbar"
            aria-label={props.t('refresh')}
            disabled={
              props.loading || props.loadingMore || props.mutationPending
            }
            icon={<IconRefreshOutlineRegular />}
            onClick={props.onRefresh}
          />
        </Tooltip>
        <Pill>{props.items.length}</Pill>
      </form>
      {props.categoryOptions.length > 0 && (
        <div
          className="dshMarketCategories"
          role="group"
          aria-label={props.t('categories')}
        >
          <span>{props.t('categories')}</span>
          {props.categoryOptions.map((category) => (
            <Pill
              key={category}
              active={props.selectedCategories.includes(category)}
              aria-pressed={props.selectedCategories.includes(category)}
              disabled={props.mutationPending}
              onClick={() => props.onToggleCategory(category)}
            >
              {category}
            </Pill>
          ))}
        </div>
      )}
      {props.partialFailure && (
        <div className="dshMarketBanner" role="status">
          <StateDot state="warning" />
          {props.t('partialFailure')}
        </div>
      )}
      {props.error !== undefined && (
        <div className="dshMarketEmpty" role="alert">
          <StateDot state="error" size={14} />
          <h2>{props.t('catalogError')}</h2>
          <p>{props.error}</p>
          <Button
            variant="outline"
            icon={<IconRefreshOutlineRegular />}
            onClick={props.onRefresh}
          >
            {props.t('retry')}
          </Button>
        </div>
      )}
      {props.error === undefined &&
        props.loading &&
        props.items.length === 0 && (
          <div className="dshMarketEmpty">
            <StateDot state="ongoing" size={16} />
            <p>{props.t('loading')}</p>
          </div>
        )}
      {props.error === undefined &&
        !props.loading &&
        props.items.length === 0 && (
          <div className="dshMarketEmpty">
            <h2>{props.t('noResults')}</h2>
          </div>
        )}
      <div className="dshMarketGrid">
        {props.items.map((value) => (
          <PluginCard
            key={`${value.source.sourceRecordId}:${value.item.id}`}
            value={value}
            onClick={() => props.onSelect(value)}
            t={props.t}
          />
        ))}
      </div>
      {(props.hasMore || props.loadMoreError !== undefined) && (
        <div className="dshMarketPagination">
          {props.loadMoreError !== undefined && (
            <div className="dshMarketPaginationError" role="status">
              {props.loadMoreError}
            </div>
          )}
          {props.hasMore && (
            <Button
              type="button"
              variant="outline"
              disabled={
                props.loading || props.loadingMore || props.mutationPending
              }
              onClick={props.onLoadMore}
            >
              {props.loadingMore ? props.t('loadingMore') : props.t('loadMore')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

export function InstallableView(props: {
  state?: MarketStateResponse | undefined
  items: readonly VisibleItem[]
  totalItems: number
  query: string
  categoryOptions: readonly string[]
  selectedCategories: readonly string[]
  metadata: MarketInstallableResponse['metadata'] | undefined
  loaded: boolean
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  unavailable: boolean
  error?: string | undefined
  operationPending: boolean
  onQuery: (value: string) => void
  onSearch: () => void
  onRefresh: () => void
  onToggleCategory: (category: string) => void
  onLoadMore: () => void
  onRetry: () => void
  onSources: () => void
  onInstall: (value: VisibleItem) => void
  t: MarketSettingsTabProps['t']
}) {
  const noSources =
    props.state !== undefined &&
    !props.state.sources.some((source) => source.enabled)
  if (noSources)
    return (
      <div className="dshMarketEmpty">
        <div className="dshMarketEmptyIcon">
          <IconGlobeOutlineRegular size={24} />
        </div>
        <h2>{props.t('emptyTitle')}</h2>
        <p>{props.t('emptyBody')}</p>
        <Button
          variant="primary"
          icon={<IconSettingsOutlineRegular />}
          onClick={props.onSources}
        >
          {props.t('chooseSources')}
        </Button>
      </div>
    )
  if (props.unavailable)
    return (
      <div className="dshMarketEmpty" role="status">
        <StateDot state="warning" size={16} />
        <h2>{props.t('desktopRequiredTitle')}</h2>
        <p>{props.t('desktopUnavailable')}</p>
      </div>
    )
  if (props.loading)
    return (
      <div className="dshMarketEmpty">
        <StateDot state="ongoing" size={16} />
        <p>{props.t('scanningInstallable')}</p>
      </div>
    )
  if (!props.loaded && props.error !== undefined)
    return (
      <div className="dshMarketEmpty" role="alert">
        <StateDot state="error" size={14} />
        <h2>{props.t('installableError')}</h2>
        <Button
          variant="outline"
          icon={<IconRefreshOutlineRegular />}
          onClick={props.onRetry}
        >
          {props.t('retry')}
        </Button>
      </div>
    )
  if (!props.loaded)
    return (
      <div className="dshMarketEmpty">
        <StateDot state="ongoing" size={16} />
        <p>{props.t('scanningInstallable')}</p>
      </div>
    )
  return (
    <div className="dshMarketContent">
      <div className="dshMarketSectionHead">
        <div>
          <h2>{props.t('installable')}</h2>
          <p>{props.t('installableBody')}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={props.loading || props.operationPending}
          icon={<IconRefreshOutlineRegular />}
          onClick={props.onRefresh}
        >
          {props.t('rescanInstallable')}
        </Button>
      </div>
      {props.metadata !== undefined && (
        <div className="dshMarketIndexMeta" role="status">
          <span>
            {props.t('scannedAt')}: {props.metadata.scannedAt}
          </span>
          {props.metadata.providerRevision !== undefined && (
            <span>
              {props.t('providerRevision')}: {props.metadata.providerRevision}
            </span>
          )}
          <span>
            {props.metadata.cacheStatus === 'fresh'
              ? props.t('freshScan')
              : props.t('cachedScan')}
          </span>
        </div>
      )}
      <form
        className="dshMarketToolbar"
        onSubmit={(event) => {
          event.preventDefault()
          props.onSearch()
        }}
      >
        <Input
          className="dshMarketSearch"
          icon={<IconSearchOutlineRegular />}
          value={props.query}
          disabled={props.operationPending}
          placeholder={props.t('search')}
          onChange={(event) => props.onQuery(event.currentTarget.value)}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={props.operationPending}
          icon={<IconSearchOutlineRegular />}
        >
          {props.t('searchAction')}
        </Button>
        <Pill>{props.totalItems}</Pill>
      </form>
      {props.categoryOptions.length > 0 && (
        <div
          className="dshMarketCategories"
          role="group"
          aria-label={props.t('categories')}
        >
          <span>{props.t('categories')}</span>
          {props.categoryOptions.map((category) => (
            <Pill
              key={category}
              active={props.selectedCategories.includes(category)}
              aria-pressed={props.selectedCategories.includes(category)}
              disabled={props.operationPending}
              onClick={() => props.onToggleCategory(category)}
            >
              {category}
            </Pill>
          ))}
        </div>
      )}
      {props.error !== undefined && (
        <div className="dshMarketBanner" role="alert">
          <StateDot state="error" />
          <span>{props.error}</span>
        </div>
      )}
      {props.items.length === 0 && !props.hasMore && (
        <div className="dshMarketEmpty">
          <h2>{props.t('noInstallable')}</h2>
          <p>{props.t('noInstallableBody')}</p>
        </div>
      )}
      <div className="dshMarketGrid">
        {props.items.map((value) => (
          <PluginCard
            key={`${value.source.sourceRecordId}:${value.item.id}`}
            value={value}
            actionLabel={props.t('install')}
            disabled={props.operationPending}
            onClick={() => props.onInstall(value)}
            t={props.t}
          />
        ))}
      </div>
      {props.hasMore && (
        <div className="dshMarketPagination">
          <Button
            type="button"
            variant="outline"
            disabled={props.operationPending || props.loadingMore}
            onClick={props.onLoadMore}
          >
            {props.loadingMore ? props.t('loadingMore') : props.t('loadMore')}
          </Button>
        </div>
      )}
    </div>
  )
}

export function InstalledView(props: {
  installations: readonly MarketInstallationView[]
  loaded: boolean
  loading: boolean
  unavailable: boolean
  error?: string | undefined
  operationPending: boolean
  onRetry: () => void
  onUninstall: (bundleId: string) => void
  t: MarketSettingsTabProps['t']
}) {
  if (props.unavailable)
    return (
      <div className="dshMarketEmpty" role="status">
        <StateDot state="warning" size={16} />
        <h2>{props.t('desktopRequiredTitle')}</h2>
        <p>{props.t('desktopUnavailable')}</p>
      </div>
    )
  if (!props.loaded && props.loading)
    return (
      <div className="dshMarketEmpty">
        <StateDot state="ongoing" size={16} />
        <p>{props.t('loadingInstallations')}</p>
      </div>
    )
  if (!props.loaded && props.error !== undefined)
    return (
      <div className="dshMarketEmpty" role="alert">
        <StateDot state="error" size={14} />
        <h2>{props.t('installationsError')}</h2>
        <Button
          variant="outline"
          icon={<IconRefreshOutlineRegular />}
          onClick={props.onRetry}
        >
          {props.t('retry')}
        </Button>
      </div>
    )
  return (
    <div className="dshMarketContent">
      <div className="dshMarketSectionHead">
        <div>
          <h2>{props.t('installed')}</h2>
          <p>{props.t('installedBody')}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={props.loading || props.operationPending}
          icon={<IconRefreshOutlineRegular />}
          onClick={props.onRetry}
        >
          {props.t('refresh')}
        </Button>
      </div>
      {props.error !== undefined && (
        <div className="dshMarketBanner" role="alert">
          <StateDot state="error" />
          {props.error}
        </div>
      )}
      {props.installations.length === 0 ? (
        <div className="dshMarketEmpty">
          <h2>{props.t('noInstalled')}</h2>
          <p>{props.t('noInstalledBody')}</p>
        </div>
      ) : (
        <div className="dshMarketReceipts">
          {props.installations.map((installation) => (
            <InstallationCard
              key={installation.bundleId}
              installation={installation}
              operationPending={props.operationPending}
              onUninstall={props.onUninstall}
              t={props.t}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function InstallationCard(props: {
  installation: MarketInstallationView
  operationPending: boolean
  onUninstall: (bundleId: string) => void
  t: MarketSettingsTabProps['t']
}) {
  const { installation } = props
  const packageName = installation.packageName
  const displayName = packageName
  return (
    <article className="dshMarketReceipt">
      <div className="dshMarketReceiptMain">
        <div className="dshMarketReceiptTitle">
          <StateDot
            state={installation.status === 'disabled' ? 'warning' : 'done'}
            size={10}
          />
          <h3>{displayName}</h3>
          <Pill>{props.t('profileDependency')}</Pill>
          <Pill>
            {props.t(
              installation.status === 'disabled'
                ? 'disabledPlugin'
                : 'activePlugin',
            )}
          </Pill>
        </div>
        <div className="dshMarketReceiptMeta">
          <span>{packageName}</span>
          {installation.status === 'disabled' && (
            <span>{props.t('disabledRestartRequired')}</span>
          )}
        </div>
      </div>
      <div className="dshMarketReceiptActions">
        {installation.action === 'uninstall' && (
          <Button
            variant="outline"
            size="sm"
            aria-label={`${props.t('uninstall')}: ${displayName}`}
            disabled={props.operationPending}
            icon={<IconTrashOutlineRegular />}
            onClick={() => props.onUninstall(installation.bundleId)}
          >
            {props.t('uninstall')}
          </Button>
        )}
      </div>
    </article>
  )
}
