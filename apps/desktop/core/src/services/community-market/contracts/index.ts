export {
  CatalogContractError,
  type CatalogContractIssue,
  type CatalogContractName,
} from './errors.js'
export type { CatalogProviderPage } from '../../../contracts/community-market/generated/catalog-provider-page.js'
export type { CatalogQuery } from '../../../contracts/community-market/generated/catalog-query.js'
export type { CatalogSnapshot } from '../../../contracts/community-market/generated/catalog-snapshot.js'
export type { CatalogSourceManifest } from '../../../contracts/community-market/generated/catalog-source.js'
export {
  catalogIdentityChoices,
  normalizeGitHubInstallSource,
  normalizePackageIdentity,
  normalizeRepositoryIdentity,
} from './identity.js'
export {
  applyScopedCatalogCursor,
  normalizeCatalogQuery,
  scopeCatalogCursor,
  serializeCatalogQuery,
} from './query.js'
export type {
  CatalogAdapter,
  CatalogFetchContext,
  CatalogHttpClient,
  CatalogHttpResponse,
  CatalogIdentityChoice,
  CatalogMediaCandidate,
  CatalogMediaRegistrar,
  CatalogMediaRole,
  CatalogSourceStore,
  LocalSourceRecord,
  NormalizedGitHubInstallSource,
  NormalizedPackageIdentity,
  NormalizedRepositoryIdentity,
  ScopedCatalogCursor,
  SourceRegistrationKind,
} from '../../../contracts/community-market/types.js'
export {
  parseCatalogProviderPage,
  parseCatalogQuery,
  parseCatalogSnapshot,
  parseCatalogSource,
  validateLocalSourceRecords,
} from './validate.js'
