'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/components/auth/auth-context'
import { resolveConsoleRoute } from '@/features/console/routes'

export function useConsoleRoute() {
  const { me } = useAuth()
  const [hash, setHash] = useState<string | null>(null)
  useEffect(() => {
    const read = () => setHash(window.location.hash)
    read()
    window.addEventListener('hashchange', read)
    return () => window.removeEventListener('hashchange', read)
  }, [])
  const route = resolveConsoleRoute(hash ?? '', me?.permissions)
  useEffect(() => {
    if (hash === null || hash === route.hash) return
    window.history.replaceState(null, '', route.hash)
    // Workbench routing and authentication share this browser event.
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  }, [hash, route.hash])
  return { ...route, ready: hash !== null }
}
