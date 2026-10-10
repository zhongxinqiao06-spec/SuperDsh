import {
  Button,
  IconCheckOutlineRegular,
  IconDataOutlineRegular,
  IconDownloadOutlineRegular,
  IconPlusOutlineRegular,
  IconRightUpOutlineRegular,
  IconSettingsOutlineRegular,
  Input,
  Modal,
  Pill,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  MarketCatalogResponse,
  MarketInstallableResponse,
  MarketInstallationView,
  MarketOperationPreviewRequest,
  MarketOperationPreviewResponse,
  MarketSourceMutation,
  MarketStateResponse,
} from '@superdsh/core/contracts/community-market/api-types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  executeMarketOperation,
  mutateMarketSource,
  openMarketTerminal,
  previewMarketOperation,
  readMarketCatalog,
  readMarketInstallable,
  readMarketInstallations,
  readMarketState,
  readMoreMarketCatalog,
  requestMarketRestart,
} from './api.js'
import { safeHttpsExternalHref } from './card-components.js'
import {
  DiscoverView,
  InstallableView,
  InstalledView,
} from './catalog-views.js'
import {
  catalogAdapterGuideUrl,
  catalogFailureMessage,
  type CompletedOperation,
  type InstallationLoadOutcome,
  installRequirementsUrl,
  isDesktopUnavailable,
  type MarketSurfaceProps,
  type MarketView,
  matchingInstallation,
  mergeCatalogPages,
  mergeInstallablePages,
  operationErrorDetails,
  operationErrorMessage,
  retainEnabledCatalog,
  selectedSource,
  type VisibleItem,
  visibleItemKey,
} from './model.js'
import {
  ItemActionModal,
  OperationConfirmModal,
  OperationSuccessModal,
} from './operation-modals.js'
import { SourcesView } from './source-views.js'

export function MarketSurface({
  initialView = 'installable',
  readLocale,
  t,
  showHeader = true,
}: MarketSurfaceProps) {
  const [view, setView] = useState<MarketView>(initialView)
  const [state, setState] = useState<MarketStateResponse>()
  const [catalog, setCatalog] = useState<MarketCatalogResponse>()
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [categoryOptions, setCategoryOptions] = useState<readonly string[]>([])
  const [selectedCategories, setSelectedCategories] = useState<
    readonly string[]
  >([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string>()
  const [loadMoreError, setLoadMoreError] = useState<string>()
  const [selected, setSelected] = useState<VisibleItem>()
  const [addOpen, setAddOpen] = useState(false)
  const [manifestUrl, setManifestUrl] = useState('')
  const [mutationError, setMutationError] = useState<string>()
  const [mutationPending, setMutationPending] = useState(false)
  const [installations, setInstallations] = useState<
    readonly MarketInstallationView[]
  >([])
  const [installableIndex, setInstallableIndex] =
    useState<MarketInstallableResponse>()
  const [installableQuery, setInstallableQuery] = useState('')
  const [appliedInstallableQuery, setAppliedInstallableQuery] = useState('')
  const [installableCategories, setInstallableCategories] = useState<
    readonly string[]
  >([])
  const [installableLoaded, setInstallableLoaded] = useState(false)
  const [installableLoading, setInstallableLoading] = useState(false)
  const [installableLoadingMore, setInstallableLoadingMore] = useState(false)
  const [installableUnavailable, setInstallableUnavailable] = useState(false)
  const [installableError, setInstallableError] = useState<string>()
  const [installationsLoaded, setInstallationsLoaded] = useState(false)
  const [installationsLoading, setInstallationsLoading] = useState(false)
  const [installationsUnavailable, setInstallationsUnavailable] =
    useState(false)
  const [installationsError, setInstallationsError] = useState<string>()
  const [selectedInstallation, setSelectedInstallation] =
    useState<MarketInstallationView>()
  const [selectedInventoryLoading, setSelectedInventoryLoading] =
    useState(false)
  const [selectedInventoryError, setSelectedInventoryError] = useState<string>()
  const [operationPreview, setOperationPreview] =
    useState<MarketOperationPreviewResponse>()
  const [operationSuccess, setOperationSuccess] = useState<CompletedOperation>()
  const [operationError, setOperationError] = useState<string>()
  const [operationErrorDetailsValue, setOperationErrorDetailsValue] =
    useState<string>()
  const [operationExecutionFailed, setOperationExecutionFailed] =
    useState(false)
  const [operationPending, setOperationPending] = useState(false)
  const [desktopActionError, setDesktopActionError] = useState<string>()
  const [desktopActionPending, setDesktopActionPending] = useState(false)
  const readRequest = useRef<AbortController>()
  const pageRequest = useRef<AbortController>()
  const mutationRequest = useRef<AbortController>()
  const installableRequest = useRef<AbortController>()
  const installationsRequest = useRef<AbortController>()
  const operationRequest = useRef<AbortController>()
  const operationStage = useRef<'preview' | 'execute'>()
  const desktopActionRequest = useRef<AbortController>()
  const selectedKeyRef = useRef<string>()
  const viewRef = useRef<MarketView>(initialView)

  const rememberCategories = useCallback((next: MarketCatalogResponse) => {
    setCategoryOptions(
      [...next.categories].sort((left, right) =>
        left.localeCompare(right, 'en', { sensitivity: 'base' }),
      ),
    )
  }, [])

  const loadCatalog = useCallback(
    async (
      nextState: MarketStateResponse,
      q: string,
      categories: readonly string[],
      forceRefresh = false,
    ) => {
      readRequest.current?.abort()
      pageRequest.current?.abort()
      pageRequest.current = undefined
      setLoadingMore(false)
      setLoadMoreError(undefined)
      const selected = selectedSource(nextState.sources)
      if (selected === undefined) {
        readRequest.current = undefined
        setCatalog(undefined)
        setQuery('')
        setAppliedQuery('')
        setCategoryOptions([])
        setSelectedCategories([])
        setError(undefined)
        setLoading(false)
        return
      }
      const effectiveQuery = q.trim()
      const request = new AbortController()
      readRequest.current = request
      setLoading(true)
      setError(undefined)
      let catalogApplied = false
      const applyCatalog = (
        next: MarketCatalogResponse,
      ): MarketCatalogResponse | undefined => {
        const retained = retainEnabledCatalog(next, nextState.sources)
        const result = retained?.results[0]
        if (retained === undefined || result?.snapshot === undefined)
          return undefined
        rememberCategories(retained)
        setAppliedQuery(effectiveQuery)
        setSelectedCategories([...categories])
        setCatalog(retained)
        catalogApplied = true
        return retained
      }
      try {
        const next = forceRefresh
          ? await readMarketCatalog(
              selected.sourceRecordId,
              effectiveQuery,
              readLocale(),
              categories,
              request.signal,
              true,
            )
          : await readMarketCatalog(
              selected.sourceRecordId,
              effectiveQuery,
              readLocale(),
              categories,
              request.signal,
            )
        if (!request.signal.aborted && readRequest.current === request) {
          const retained = applyCatalog(next)
          if (retained === undefined) {
            setError(
              catalogFailureMessage(
                { code: 'catalog-invalid-response' },
                selected,
                t,
              ),
            )
            return
          }
          if (
            !forceRefresh &&
            effectiveQuery === '' &&
            categories.length === 0 &&
            retained.results[0]?.stale === true
          ) {
            const refreshed = await readMarketCatalog(
              selected.sourceRecordId,
              effectiveQuery,
              readLocale(),
              categories,
              request.signal,
              true,
            )
            if (!request.signal.aborted && readRequest.current === request)
              applyCatalog(refreshed)
          }
        }
      } catch (cause) {
        if (
          !request.signal.aborted &&
          readRequest.current === request &&
          !catalogApplied
        ) {
          setError(catalogFailureMessage(cause, selected, t))
        }
      } finally {
        if (readRequest.current === request) {
          readRequest.current = undefined
          setLoading(false)
        }
      }
    },
    [readLocale, rememberCategories, t],
  )

  const loadState = useCallback(
    async (
      q: string,
      categories: readonly string[],
      forceRefresh = false,
      loadCatalogAfterState = true,
    ) => {
      if (mutationRequest.current !== undefined) return
      readRequest.current?.abort()
      pageRequest.current?.abort()
      pageRequest.current = undefined
      setLoadingMore(false)
      setLoadMoreError(undefined)
      const request = new AbortController()
      readRequest.current = request
      setLoading(true)
      setError(undefined)
      try {
        const next = await readMarketState(request.signal)
        if (request.signal.aborted || readRequest.current !== request) return
        setState(next)
        setCatalog((current) => retainEnabledCatalog(current, next.sources))
        readRequest.current = undefined
        if (!loadCatalogAfterState) {
          if (viewRef.current === 'discover') {
            await loadCatalog(next, q, categories, forceRefresh)
          } else {
            setLoading(false)
          }
          return
        }
        await loadCatalog(next, q, categories, forceRefresh)
      } catch {
        if (!request.signal.aborted && readRequest.current === request)
          setError(t('catalogError'))
      } finally {
        if (readRequest.current === request) {
          readRequest.current = undefined
          setLoading(false)
        }
      }
    },
    [loadCatalog, t],
  )

  const loadInstallations = useCallback(async (): Promise<
    InstallationLoadOutcome | undefined
  > => {
    installationsRequest.current?.abort()
    const request = new AbortController()
    installationsRequest.current = request
    setInstallationsLoading(true)
    setInstallationsError(undefined)
    setInstallationsUnavailable(false)
    try {
      const response = await readMarketInstallations(request.signal)
      if (request.signal.aborted || installationsRequest.current !== request)
        return
      setInstallations(response.installations)
      setInstallationsLoaded(true)
      setInstallationsUnavailable(false)
      return { installations: response.installations }
    } catch (cause) {
      if (request.signal.aborted || installationsRequest.current !== request)
        return
      const message = isDesktopUnavailable(cause)
        ? t('desktopUnavailable')
        : t('installationsError')
      setInstallationsUnavailable(isDesktopUnavailable(cause))
      setInstallationsError(message)
      return { error: message }
    } finally {
      if (installationsRequest.current === request) {
        installationsRequest.current = undefined
        setInstallationsLoading(false)
      }
    }
  }, [t])

  const loadInstallable = useCallback(
    async (
      refresh = false,
      q = '',
      categories: readonly string[] = [],
      page?: { readonly sourceRecordId: string; readonly cursor: string },
    ) => {
      installableRequest.current?.abort()
      const request = new AbortController()
      installableRequest.current = request
      const append = page !== undefined
      if (append) {
        setInstallableLoadingMore(true)
      } else {
        setInstallableIndex(undefined)
        setInstallableLoaded(false)
        setInstallableLoading(true)
      }
      setInstallableError(undefined)
      setInstallableUnavailable(false)
      try {
        const response = await readMarketInstallable(
          readLocale(),
          {
            ...(q.trim() === '' ? {} : { q: q.trim() }),
            ...(categories.length === 0 ? {} : { categories }),
            ...(page === undefined ? {} : page),
            refresh,
          },
          request.signal,
        )
        if (request.signal.aborted || installableRequest.current !== request)
          return
        setInstallableIndex((current) =>
          append ? mergeInstallablePages(current, response) : response,
        )
        setInstallableLoaded(true)
        setInstallableUnavailable(false)
        setAppliedInstallableQuery(q.trim())
        setInstallableCategories([...categories])
      } catch (cause) {
        if (request.signal.aborted || installableRequest.current !== request)
          return
        if (!append) {
          setInstallableIndex(undefined)
          setInstallableLoaded(false)
        }
        setInstallableUnavailable(isDesktopUnavailable(cause))
        setInstallableError(
          isDesktopUnavailable(cause)
            ? t('desktopUnavailable')
            : t('installableError'),
        )
      } finally {
        if (installableRequest.current === request) {
          installableRequest.current = undefined
          if (append) setInstallableLoadingMore(false)
          else setInstallableLoading(false)
        }
      }
    },
    [readLocale, t],
  )

  useEffect(() => {
    setQuery('')
    if (viewRef.current === 'installable') {
      void loadState('', [], false, false)
      void loadInstallable(false, '', [])
    } else {
      void loadState('', [])
    }
    return () => {
      readRequest.current?.abort()
      pageRequest.current?.abort()
      mutationRequest.current?.abort()
      installableRequest.current?.abort()
      installationsRequest.current?.abort()
      operationRequest.current?.abort()
      desktopActionRequest.current?.abort()
      readRequest.current = undefined
      pageRequest.current = undefined
      mutationRequest.current = undefined
      installableRequest.current = undefined
      installationsRequest.current = undefined
      operationRequest.current = undefined
      desktopActionRequest.current = undefined
    }
  }, [loadInstallable, loadState])

  useEffect(() => {
    // Source state can resolve before React commits it. Load after the view and
    // state are committed, so a click in that gap cannot miss the first catalog.
    if (
      view === 'discover' &&
      state !== undefined &&
      selectedSource(state.sources) !== undefined &&
      catalog === undefined &&
      readRequest.current === undefined
    ) {
      void loadCatalog(state, appliedQuery, selectedCategories)
    }
  }, [view, state, catalog, appliedQuery, selectedCategories, loadCatalog])

  const items = useMemo(
    () =>
      catalog?.results.flatMap((result) =>
        (result.snapshot?.items ?? []).map((item) => ({
          item,
          source: result.source,
          stale: result.stale,
        })),
      ) ?? [],
    [catalog],
  )
  const installableCategoryOptions = installableIndex?.categories ?? []
  const installableItems = useMemo(
    () =>
      (installableIndex?.items ?? []).map((item) => ({
        item,
        source: installableIndex!.source,
        stale: false,
      })),
    [installableIndex],
  )
  const pageTarget = useMemo(
    () =>
      catalog?.results
        .flatMap((result) => {
          const cursor = result.snapshot?.page?.nextCursor
          return cursor === undefined
            ? []
            : [{ sourceRecordId: result.source.sourceRecordId, cursor }]
        })
        .at(0),
    [catalog],
  )
  const partialFailure =
    catalog?.results.some((result) => result.error !== undefined) ?? false
  const currentSource =
    state === undefined ? undefined : selectedSource(state.sources)
  const currentSourceHref =
    currentSource === undefined
      ? undefined
      : (safeHttpsExternalHref(currentSource.homepage) ??
        safeHttpsExternalHref(currentSource.attribution?.url))
  const selectedManualInstall = useMemo(() => {
    if (selected === undefined) return undefined
    const hints =
      view === 'installable'
        ? (installableIndex?.manualInstall ?? [])
        : (catalog?.manualInstall ?? [])
    return hints.find(
      (hint) =>
        hint.sourceRecordId === selected.source.sourceRecordId &&
        hint.providerId === selected.source.providerId &&
        hint.itemId === selected.item.id,
    )
  }, [catalog, installableIndex, selected, view])

  const mutate = async (mutation: MarketSourceMutation): Promise<boolean> => {
    if (mutationRequest.current !== undefined) return false
    readRequest.current?.abort()
    pageRequest.current?.abort()
    installableRequest.current?.abort()
    readRequest.current = undefined
    pageRequest.current = undefined
    installableRequest.current = undefined
    setLoading(false)
    setLoadingMore(false)
    setLoadMoreError(undefined)
    const request = new AbortController()
    mutationRequest.current = request
    setMutationPending(true)
    setMutationError(undefined)
    try {
      const sources = await mutateMarketSource(mutation, request.signal)
      if (request.signal.aborted || mutationRequest.current !== request)
        return false
      const next: MarketStateResponse = {
        sources,
        builtIns: state?.builtIns ?? [],
        desktopActions: state?.desktopActions ?? {
          openTerminal: false,
          requestRestart: false,
        },
      }
      const sourceChanged =
        selectedSource(state?.sources ?? [])?.sourceRecordId !==
        selectedSource(sources)?.sourceRecordId
      setState(next)
      if (sourceChanged) {
        setCatalog(undefined)
        setInstallableIndex(undefined)
        setInstallableLoaded(false)
        setInstallableLoading(false)
        setInstallableLoadingMore(false)
        setInstallableUnavailable(false)
        setInstallableError(undefined)
        setInstallableQuery('')
        setAppliedInstallableQuery('')
        setInstallableCategories([])
        setQuery('')
        setAppliedQuery('')
        setCategoryOptions([])
        setSelectedCategories([])
        selectedKeyRef.current = undefined
        setSelected(undefined)
      } else {
        setCatalog((current) => retainEnabledCatalog(current, sources))
      }
      mutationRequest.current = undefined
      setMutationPending(false)
      await loadCatalog(
        next,
        sourceChanged ? '' : appliedQuery,
        sourceChanged ? [] : selectedCategories,
      )
      return true
    } catch {
      if (!request.signal.aborted && mutationRequest.current === request)
        setMutationError(t('sourceError'))
      return false
    } finally {
      if (mutationRequest.current === request) {
        mutationRequest.current = undefined
        setMutationPending(false)
      }
    }
  }

  const toggleCategory = (category: string) => {
    if (state === undefined) return
    const categories = selectedCategories.includes(category)
      ? selectedCategories.filter((value) => value !== category)
      : [...selectedCategories, category]
    selectedKeyRef.current = undefined
    setSelected(undefined)
    void loadCatalog(state, appliedQuery, categories)
  }

  const loadMore = async () => {
    if (pageRequest.current !== undefined || pageTarget === undefined) return
    const request = new AbortController()
    pageRequest.current = request
    setLoadingMore(true)
    setLoadMoreError(undefined)
    try {
      const next = await readMoreMarketCatalog(
        pageTarget.sourceRecordId,
        pageTarget.cursor,
        appliedQuery,
        readLocale(),
        selectedCategories,
        request.signal,
      )
      if (request.signal.aborted || pageRequest.current !== request) return
      const page = next.results.find(
        (value) => value.source.sourceRecordId === pageTarget.sourceRecordId,
      )
      if (page?.snapshot === undefined || page.error !== undefined) {
        setLoadMoreError(t('loadMoreError'))
        return
      }
      rememberCategories(next)
      setCatalog((current) =>
        mergeCatalogPages(current, [page], next.manualInstall),
      )
    } catch {
      if (!request.signal.aborted && pageRequest.current === request)
        setLoadMoreError(t('loadMoreError'))
    } finally {
      if (pageRequest.current === request) {
        pageRequest.current = undefined
        setLoadingMore(false)
      }
    }
  }

  const selectMarketView = (next: MarketView) => {
    if (viewRef.current === next) return
    viewRef.current = next
    setView(next)
    selectedKeyRef.current = undefined
    setSelected(undefined)
    setOperationError(undefined)
    setOperationErrorDetailsValue(undefined)
    setOperationExecutionFailed(false)
    if (next === 'installable') {
      installationsRequest.current?.abort()
      installationsRequest.current = undefined
      setInstallationsLoading(false)
      void loadInstallable(
        false,
        appliedInstallableQuery,
        installableCategories,
      )
    } else if (next === 'installed') {
      installableRequest.current?.abort()
      installableRequest.current = undefined
      setInstallableLoading(false)
      setInstallableLoadingMore(false)
      void loadInstallations()
    } else if (next === 'discover') {
      installableRequest.current?.abort()
      installationsRequest.current?.abort()
      installableRequest.current = undefined
      installationsRequest.current = undefined
      setInstallableLoading(false)
      setInstallableLoadingMore(false)
      setInstallationsLoading(false)
    } else {
      installableRequest.current?.abort()
      installationsRequest.current?.abort()
      installableRequest.current = undefined
      installationsRequest.current = undefined
      setInstallableLoading(false)
      setInstallationsLoading(false)
    }
  }

  const beginOperationPreview = async (
    requestValue: MarketOperationPreviewRequest,
  ) => {
    if (operationRequest.current !== undefined) return
    const request = new AbortController()
    operationRequest.current = request
    operationStage.current = 'preview'
    setOperationPending(true)
    setOperationError(undefined)
    setOperationErrorDetailsValue(undefined)
    setOperationExecutionFailed(false)
    setDesktopActionError(undefined)
    setOperationSuccess(undefined)
    try {
      const preview = await previewMarketOperation(requestValue, request.signal)
      if (request.signal.aborted || operationRequest.current !== request) return
      if (preview.action !== requestValue.action)
        throw new Error('operation preview action mismatch')
      setInstallationsUnavailable(false)
      setOperationPreview(preview)
    } catch (cause) {
      if (request.signal.aborted || operationRequest.current !== request) return
      if (isDesktopUnavailable(cause)) {
        setInstallationsUnavailable(true)
        setInstallationsError(t('desktopUnavailable'))
        setOperationError(t('desktopUnavailable'))
      } else {
        setOperationError(
          operationErrorMessage(
            cause,
            t(
              requestValue.action === 'install'
                ? 'previewError'
                : 'uninstallPreviewError',
            ),
          ),
        )
      }
    } finally {
      if (operationRequest.current === request) {
        operationRequest.current = undefined
        operationStage.current = undefined
        setOperationPending(false)
      }
    }
  }

  const openItem = (value: VisibleItem) => {
    if (operationStage.current === 'execute') return
    if (operationStage.current === 'preview') {
      operationRequest.current?.abort()
      operationRequest.current = undefined
      operationStage.current = undefined
      setOperationPending(false)
    }
    const selectionKey = visibleItemKey(value)
    selectedKeyRef.current = selectionKey
    setSelected(value)
    setSelectedInstallation(undefined)
    setSelectedInventoryLoading(false)
    setSelectedInventoryError(undefined)
    setOperationPreview(undefined)
    setOperationSuccess(undefined)
    setOperationError(undefined)
    setOperationErrorDetailsValue(undefined)
    setOperationExecutionFailed(false)
    setDesktopActionError(undefined)
    const beginInstallPreview = () => {
      if (selectedKeyRef.current !== selectionKey) return
      void beginOperationPreview({
        action: 'install',
        sourceRecordId: value.source.sourceRecordId,
        itemId: value.item.id,
      })
    }
    const packageName = value.item.package?.name
    if (packageName === undefined) {
      beginInstallPreview()
      return
    }
    const resolveInventory = (current: readonly MarketInstallationView[]) => {
      if (selectedKeyRef.current !== selectionKey) return
      const installation = matchingInstallation(value, current)
      setSelectedInventoryLoading(false)
      if (installation !== undefined) setSelectedInstallation(installation)
      else beginInstallPreview()
    }
    if (installationsLoaded) {
      resolveInventory(installations)
      return
    }
    setSelectedInventoryLoading(true)
    void loadInstallations().then((outcome) => {
      if (selectedKeyRef.current !== selectionKey || outcome === undefined)
        return
      if ('error' in outcome) {
        setSelectedInventoryLoading(false)
        setSelectedInventoryError(outcome.error)
        return
      }
      resolveInventory(outcome.installations)
    })
  }

  const closeItem = () => {
    if (operationPending && operationPreview !== undefined) return
    operationRequest.current?.abort()
    operationRequest.current = undefined
    operationStage.current = undefined
    desktopActionRequest.current?.abort()
    desktopActionRequest.current = undefined
    setOperationPending(false)
    setDesktopActionPending(false)
    selectedKeyRef.current = undefined
    setSelected(undefined)
    setSelectedInstallation(undefined)
    setSelectedInventoryLoading(false)
    setSelectedInventoryError(undefined)
    setOperationPreview(undefined)
    setOperationError(undefined)
    setOperationErrorDetailsValue(undefined)
    setOperationExecutionFailed(false)
    setDesktopActionError(undefined)
  }

  const executePreview = async () => {
    const preview = operationPreview
    if (preview === undefined || operationRequest.current !== undefined) return
    const request = new AbortController()
    operationRequest.current = request
    operationStage.current = 'execute'
    setOperationPending(true)
    setOperationError(undefined)
    setOperationErrorDetailsValue(undefined)
    setOperationExecutionFailed(false)
    setDesktopActionError(undefined)
    try {
      const result = await executeMarketOperation(
        preview.previewId,
        request.signal,
      )
      if (request.signal.aborted || operationRequest.current !== request) return
      if (result.action !== preview.action)
        throw new Error('operation response action mismatch')
      setInstallations((current) => {
        if (result.action === 'install') return current
        return current.filter(
          (installation) => installation.packageName !== result.packageName,
        )
      })
      setInstallationsLoaded(true)
      setOperationPreview(undefined)
      selectedKeyRef.current = undefined
      setSelected(undefined)
      setOperationSuccess({ preview, restartToken: result.restartToken })
      if (result.action === 'install' && viewRef.current === 'installable') {
        void loadInstallable(
          false,
          appliedInstallableQuery,
          installableCategories,
        )
      }
      if (result.action === 'uninstall' && viewRef.current === 'installed') {
        void loadInstallations()
      }
    } catch (cause) {
      if (request.signal.aborted || operationRequest.current !== request) return
      setOperationExecutionFailed(true)
      setOperationErrorDetailsValue(operationErrorDetails(cause))
      if (isDesktopUnavailable(cause)) {
        setInstallationsUnavailable(true)
        setInstallationsError(t('desktopUnavailable'))
        setOperationError(t('desktopUnavailable'))
      } else {
        setOperationError(operationErrorMessage(cause, t('executeError')))
      }
    } finally {
      if (operationRequest.current === request) {
        operationRequest.current = undefined
        operationStage.current = undefined
        setOperationPending(false)
      }
    }
  }

  const runDesktopAction = async (
    action: 'open-terminal' | 'request-restart',
    restartToken?: string,
  ) => {
    if (desktopActionRequest.current !== undefined) return
    const request = new AbortController()
    desktopActionRequest.current = request
    setDesktopActionPending(true)
    setDesktopActionError(undefined)
    try {
      if (action === 'open-terminal') await openMarketTerminal(request.signal)
      else if (restartToken !== undefined)
        await requestMarketRestart(restartToken, request.signal)
      else throw new Error('restart token missing')
    } catch (cause) {
      if (request.signal.aborted || desktopActionRequest.current !== request)
        return
      setDesktopActionError(
        t(
          isDesktopUnavailable(cause)
            ? 'desktopActionUnavailable'
            : action === 'open-terminal'
              ? 'terminalError'
              : 'restartError',
        ),
      )
    } finally {
      if (desktopActionRequest.current === request) {
        desktopActionRequest.current = undefined
        setDesktopActionPending(false)
      }
    }
  }

  return (
    <section
      className="dshMarketRoot"
      aria-label={t('title')}
      aria-busy={
        loading ||
        loadingMore ||
        mutationPending ||
        installationsLoading ||
        operationPending ||
        desktopActionPending
      }
    >
      {showHeader && (
        <header className="dshMarketHeader">
          <div className="dshMarketHeaderTitle">
            <h2>{t('title')}</h2>
            <p>{t('subtitle')}</p>
          </div>
        </header>
      )}
      <div className="dshMarketViewBar">
        <div
          className="dshMarketViewSwitch"
          role="group"
          aria-label={t('title')}
        >
          <Pill
            active={view === 'discover'}
            aria-pressed={view === 'discover'}
            onClick={() => selectMarketView('discover')}
          >
            <IconDataOutlineRegular size={14} />
            <span>{t('discover')}</span>
          </Pill>
          <Pill
            active={view === 'installable'}
            aria-pressed={view === 'installable'}
            onClick={() => selectMarketView('installable')}
          >
            <IconDownloadOutlineRegular size={14} />
            <span>{t('installable')}</span>
          </Pill>
          <Pill
            active={view === 'installed'}
            aria-pressed={view === 'installed'}
            onClick={() => selectMarketView('installed')}
          >
            <IconCheckOutlineRegular size={14} />
            <span>{t('installed')}</span>
          </Pill>
          <Pill
            active={view === 'sources'}
            aria-pressed={view === 'sources'}
            onClick={() => selectMarketView('sources')}
          >
            <IconSettingsOutlineRegular size={14} />
            <span>{t('sources')}</span>
          </Pill>
        </div>
        <Pill className="dshMarketCurrentSource">
          {currentSource === undefined ? (
            t('noSourceSelected')
          ) : currentSourceHref === undefined ? (
            `${t('currentSource')}: ${currentSource.name}`
          ) : (
            <a
              href={currentSourceHref}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('currentSource')}: {currentSource.name}{' '}
              <IconRightUpOutlineRegular size={12} />
            </a>
          )}
        </Pill>
      </div>
      <main className="dshMarketMain">
        {view === 'discover' ? (
          <DiscoverView
            state={state}
            items={items}
            metadata={catalog?.metadata}
            query={query}
            categoryOptions={categoryOptions}
            selectedCategories={selectedCategories}
            loading={loading}
            loadingMore={loadingMore}
            mutationPending={mutationPending}
            error={error}
            loadMoreError={loadMoreError}
            partialFailure={partialFailure}
            onQuery={setQuery}
            onSearch={() =>
              state !== undefined &&
              void loadCatalog(state, query, selectedCategories)
            }
            onRefresh={() =>
              void loadState(appliedQuery, selectedCategories, true)
            }
            onToggleCategory={toggleCategory}
            onLoadMore={() => {
              void loadMore()
            }}
            hasMore={pageTarget !== undefined}
            onSources={() => selectMarketView('sources')}
            onSelect={openItem}
            t={t}
          />
        ) : view === 'installable' ? (
          <InstallableView
            state={state}
            items={installableItems}
            totalItems={installableItems.length}
            query={installableQuery}
            categoryOptions={installableCategoryOptions}
            selectedCategories={installableCategories}
            metadata={installableIndex?.metadata}
            loaded={installableLoaded}
            loading={installableLoading}
            loadingMore={installableLoadingMore}
            hasMore={installableIndex?.nextCursor !== undefined}
            unavailable={installableUnavailable}
            error={installableError}
            operationPending={operationPending}
            onQuery={setInstallableQuery}
            onSearch={() => {
              void loadInstallable(
                false,
                installableQuery,
                installableCategories,
              )
            }}
            onRefresh={() => {
              void loadInstallable(
                true,
                appliedInstallableQuery,
                installableCategories,
              )
            }}
            onToggleCategory={(category) => {
              const nextCategories = installableCategories.includes(category)
                ? installableCategories.filter((value) => value !== category)
                : [...installableCategories, category]
              void loadInstallable(
                false,
                appliedInstallableQuery,
                nextCategories,
              )
            }}
            onLoadMore={() => {
              if (installableIndex?.nextCursor === undefined) return
              void loadInstallable(
                false,
                appliedInstallableQuery,
                installableCategories,
                {
                  sourceRecordId: installableIndex.source.sourceRecordId,
                  cursor: installableIndex.nextCursor,
                },
              )
            }}
            onRetry={() => {
              void loadInstallable(
                false,
                appliedInstallableQuery,
                installableCategories,
              )
            }}
            onSources={() => selectMarketView('sources')}
            onInstall={openItem}
            t={t}
          />
        ) : view === 'installed' ? (
          <InstalledView
            installations={installations}
            loaded={installationsLoaded}
            loading={installationsLoading}
            unavailable={installationsUnavailable}
            error={installationsError ?? operationError}
            operationPending={operationPending}
            onRetry={() => {
              void loadInstallations()
            }}
            onUninstall={(bundleId) => {
              void beginOperationPreview({ action: 'uninstall', bundleId })
            }}
            t={t}
          />
        ) : (
          <SourcesView
            state={state}
            catalog={catalog}
            error={mutationError}
            pending={mutationPending}
            adapterGuideHref={catalogAdapterGuideUrl(readLocale())}
            onMutation={(mutation) => {
              void mutate(mutation)
            }}
            onAddStandard={() => setAddOpen(true)}
            t={t}
          />
        )}
      </main>
      {selected !== undefined && (
        <ItemActionModal
          value={selected}
          installation={selectedInstallation}
          inventoryLoading={selectedInventoryLoading}
          inventoryError={selectedInventoryError}
          manualInstall={selectedManualInstall}
          preview={
            operationPreview?.action === 'install'
              ? operationPreview
              : undefined
          }
          pending={operationPending}
          operationError={operationError}
          operationDetails={operationErrorDetailsValue}
          executionFailed={operationExecutionFailed}
          desktopActionError={desktopActionError}
          desktopActionPending={desktopActionPending}
          canOpenTerminal={state?.desktopActions.openTerminal === true}
          verificationHelpHref={installRequirementsUrl(readLocale())}
          onClose={closeItem}
          onConfirm={() => {
            void executePreview()
          }}
          onOpenTerminal={() => {
            void runDesktopAction('open-terminal')
          }}
          onUninstall={(bundleId) => {
            selectedKeyRef.current = undefined
            setSelected(undefined)
            setSelectedInstallation(undefined)
            void beginOperationPreview({ action: 'uninstall', bundleId })
          }}
          t={t}
        />
      )}
      {selected === undefined && operationPreview !== undefined && (
        <OperationConfirmModal
          preview={operationPreview}
          pending={operationPending}
          error={operationError}
          onCancel={() => {
            if (operationPending) return
            setOperationPreview(undefined)
            setOperationError(undefined)
            setOperationErrorDetailsValue(undefined)
            setOperationExecutionFailed(false)
          }}
          onConfirm={() => {
            void executePreview()
          }}
          t={t}
        />
      )}
      {operationSuccess !== undefined && (
        <OperationSuccessModal
          operation={operationSuccess}
          canRestart={state?.desktopActions.requestRestart === true}
          pending={desktopActionPending}
          error={desktopActionError}
          onClose={() => setOperationSuccess(undefined)}
          onRestart={() => {
            void runDesktopAction(
              'request-restart',
              operationSuccess.restartToken,
            )
          }}
          t={t}
        />
      )}
      <Modal
        open={addOpen}
        className="dshMarketModal dshMarketSourceModal"
        contentClassName="dshMarketModalContent"
        onClose={() => {
          if (!mutationPending) setAddOpen(false)
        }}
        title={t('addStandard')}
        closeLabel={t('cancel')}
        description={t('sourceNotice')}
        footer={
          <div className="dshMarketModalActions">
            <Button
              variant="ghost"
              disabled={mutationPending}
              onClick={() => setAddOpen(false)}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              icon={<IconPlusOutlineRegular />}
              disabled={mutationPending || !manifestUrl.trim()}
              onClick={() => {
                void mutate({
                  action: 'add-standard',
                  manifestUrl: manifestUrl.trim(),
                }).then((succeeded) => {
                  if (!succeeded) return
                  setManifestUrl('')
                  setAddOpen(false)
                })
              }}
            >
              {t('confirmAdd')}
            </Button>
          </div>
        }
      >
        <div className="dshMarketModalField">
          <label htmlFor="dsh-market-manifest">{t('standardSource')}</label>
          <Input
            id="dsh-market-manifest"
            value={manifestUrl}
            disabled={mutationPending}
            placeholder={t('manifestPlaceholder')}
            onChange={(event) => setManifestUrl(event.currentTarget.value)}
          />
          {mutationError !== undefined && (
            <div className="dshMarketError" role="alert">
              {mutationError}
            </div>
          )}
        </div>
      </Modal>
    </section>
  )
}
