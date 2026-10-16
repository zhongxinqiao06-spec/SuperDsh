import type { IconProps } from './icons/props.ts'

/** Compatibility exports for brand slots and masks; the artwork is Starbridge. */
export const FISH_LOGO_VIEWBOX = { width: 256, height: 256 }

/** Bridge and star geometry from the owned starbridge-mark.svg source. */
export const FISH_LOGO_PATH =
  'M46 188v-43c0-40 30-70 70-70s70 30 70 70v43h-22v-43c0-27-21-48-48-48s-48 21-48 48v43H46Z M36 150h160v22H36z M190 35l7.5 20.5L218 63l-20.5 7.5L190 91l-7.5-20.5L162 63l20.5-7.5L190 35Z'

/**
 * Render the product mark while preserving the existing public icon contract.
 * @param props.size - square edge in pixels.
 * @param props.className - host presentation; ink follows currentColor.
 * @returns decorative Starbridge SVG.
 */
export function FishLogo({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 256 256"
      fill="none"
      aria-hidden="true"
    >
      <path d={FISH_LOGO_PATH} fill="currentColor" />
    </svg>
  )
}
