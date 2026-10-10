import { useEffect, useLayoutEffect } from 'react'
import { productNavigation } from '../../app/navigation.ts'
import { usePlatformWorkspace } from './use-platform-workspace.ts'
import { publishProductWorkspace } from './product-workspace-store.ts'
import { PlatformAccountDialog } from './PlatformAccountDialog.tsx'
import './platform.css'

/** Owns platform state; chat and session views remain inside the product layout. */
export function ProductWorkspace() {
  const model = usePlatformWorkspace()
  useLayoutEffect(() => {
    publishProductWorkspace(model)
  })
  useEffect(
    () => () => {
      publishProductWorkspace(null)
    },
    [],
  )
  useEffect(() => {
    const reveal = () => productNavigation.navigate(null)
    window.addEventListener('superdsh:conversation-target', reveal)
    return () =>
      window.removeEventListener('superdsh:conversation-target', reveal)
  }, [])
  return <PlatformAccountDialog model={model} />
}
