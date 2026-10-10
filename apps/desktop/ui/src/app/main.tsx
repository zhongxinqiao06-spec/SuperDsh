import { createRoot } from 'react-dom/client'
import { ProductApp, ProductErrorBoundary } from './ProductApp.tsx'
import '../compatibility/harness/web/base.css'

const container = document.getElementById('root')
if (!container) throw new Error('SuperDsh requires a root element')
createRoot(container).render(
  <ProductErrorBoundary>
    <ProductApp />
  </ProductErrorBoundary>,
)
