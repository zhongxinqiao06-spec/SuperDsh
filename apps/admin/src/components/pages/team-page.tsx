'use client'

import { ManagementPage } from './management-page'

/** Preserve the historical team route while using permission-based management. */
export function TeamPage() {
  return <ManagementPage initialTab="users" />
}
