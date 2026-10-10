import { MarketSurface } from './MarketSurface.js'
import { type MarketSettingsTabProps } from './model.js'

export function MarketSettingsTab({
  initialView,
  readLocale,
  t,
}: MarketSettingsTabProps) {
  return (
    <MarketSurface
      {...(initialView === undefined ? {} : { initialView })}
      readLocale={readLocale}
      t={t}
    />
  )
}
export { MarketSurface } from './MarketSurface.js'
export type {
  MarketSettingsTabProps,
  MarketSurfaceProps,
  MarketView,
} from './model.js'
