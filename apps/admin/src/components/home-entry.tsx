'use client'

import { useEffect, useState, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import { isWorkspaceEntry } from '@/features/auth/home-entry'
import { LoadingState } from '@/components/loading-state'

const AuthRouter = dynamic(
  () =>
    import('@/components/auth/auth-router').then((module) => module.AuthRouter),
  {
    ssr: false,
    loading: () => <LoadingState className="min-h-dvh bg-background" />,
  },
)

export function HomeEntry({ children }: { children: ReactNode }) {
  const [workspace, setWorkspace] = useState(false)

  useEffect(() => {
    // Keep this event-driven: AuthProvider removes OAuth query parameters on mount.
    // Re-reading them during render would interrupt a callback already in progress.
    const update = () => setWorkspace(isWorkspaceEntry(window.location))
    update()
    window.addEventListener('hashchange', update)
    window.addEventListener('popstate', update)
    return () => {
      window.removeEventListener('hashchange', update)
      window.removeEventListener('popstate', update)
    }
  }, [])

  return workspace ? <AuthRouter /> : children
}
