const websiteAnchors = new Set([
  '',
  '#',
  '#top',
  '#main-content',
  '#capabilities',
  '#workflow',
  '#scenarios',
  '#architecture',
  '#connected',
  '#faq',
  '#start',
])

/** Preserve existing console and native OAuth URLs alongside the public homepage. */
export function isWorkspaceEntry({
  hash,
  search,
}: Pick<Location, 'hash' | 'search'>): boolean {
  if (!websiteAnchors.has(hash)) return true
  return [...new URLSearchParams(search).keys()].some((key) =>
    key.startsWith('oauth_'),
  )
}
