import { FISH_LOGO_PATH } from './FishLogo.tsx'
import type { IconProps } from './icons/props.ts'

/** Display options for the owned product wordmark. */
export interface BrandWordmarkProps extends IconProps {
  /** Whether to include the leading Starbridge mark. */
  includeMark?: boolean | undefined
}

/**
 * Render the Starbridge wordmark in the existing brand slot.
 * @param props.size - artwork height in pixels.
 * @param props.className - host layout class.
 * @param props.includeMark - whether the host already shows a separate mark.
 * @returns decorative product name and optional bridge mark.
 */
export function BrandWordmark({
  size = 24,
  className,
  includeMark = true,
}: BrandWordmarkProps) {
  const width = includeMark ? 146 : 116
  return (
    <svg
      width={(size * width) / 24}
      height={size}
      className={className}
      viewBox={includeMark ? '0 0 146 24' : '30 0 116 24'}
      fill="currentColor"
      aria-hidden="true"
    >
      {includeMark && <path d={FISH_LOGO_PATH} transform="scale(.09375)" />}
      <text
        x="30"
        y="17.5"
        fontFamily="system-ui, sans-serif"
        fontSize="17"
        fontWeight="600"
        letterSpacing="1.5"
      >
        星桥智能平台
      </text>
    </svg>
  )
}
