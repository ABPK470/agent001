/**
 * Geometric MI / A — login brand lockup.
 *
 * One material with Logo colon: bar weight, rx, solid `currentColor`.
 * Stems = rounded rects. Diagonals = constant-weight strokes with round
 * joins (same optical weight, soft tips/valleys). No thin triangle
 * silhouettes, no painted background cutouts.
 */

import { memo, useId, type CSSProperties, type SVGProps } from "react"

/** Lockup metrics — shared by intro CSS (`--wm-mi-w` / `--wm-a-w` ratios). */
export const BRAND_LETTER_CONFIG = {
  /** Matches Logo colon block corner radius. */
  rx: 3,
  /** Stem / diagonal weight — slightly under colon block (9) for open counters. */
  bar: 7,
  height: 32,
  miWidth: 50,
  /** Wider than tall so the A counter stays readable at lockup size. */
  aWidth: 34,
  mInnerWidth: 36,
} as const

/** @deprecated Prefer `BRAND_LETTER_CONFIG.rx` */
export const BRAND_LETTER_RX = BRAND_LETTER_CONFIG.rx
/** @deprecated Prefer `BRAND_LETTER_CONFIG.bar` */
export const BRAND_LETTER_BAR = BRAND_LETTER_CONFIG.bar
/** @deprecated Prefer `BRAND_LETTER_CONFIG.height` */
export const BRAND_LETTER_HEIGHT = BRAND_LETTER_CONFIG.height
/** @deprecated Prefer `BRAND_LETTER_CONFIG.miWidth` */
export const BRAND_MI_VIEW_W = BRAND_LETTER_CONFIG.miWidth
/** @deprecated Prefer `BRAND_LETTER_CONFIG.aWidth` */
export const BRAND_A_VIEW_W = BRAND_LETTER_CONFIG.aWidth

export interface BrandLetterProps extends SVGProps<SVGSVGElement> {
  /**
   * Accessible name. When set → `role="img"` + `<title>`.
   * When omitted → decorative (`aria-hidden`); parent supplies the label.
   */
  title?: string
  /** Explicit size; omit to fill the CSS box (`width/height: 100%`). */
  size?: number | string
}

function brandAria(title: string | undefined): {
  "aria-label"?: string
  "aria-hidden"?: true
  role?: "img"
} {
  if (title) return { "aria-label": title, role: "img" }
  return { "aria-hidden": true }
}

function brandBoxStyle(style: CSSProperties | undefined): CSSProperties {
  return {
    display: "block",
    flexShrink: 0,
    overflow: "visible",
    ...style,
  }
}

function fmt(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2)
}

/** Geometric “MI” — rounded stems + stroke valley (round join). */
export const BrandLetterMi = memo(function BrandLetterMi({
  className,
  title,
  size,
  style,
  ...rest
}: BrandLetterProps) {
  const { bar: b, rx, height: h, miWidth: viewW, mInnerWidth: mW } = BRAND_LETTER_CONFIG
  const half = b / 2
  const mid = mW / 2
  const iX = viewW - b
  // Valley seats into stem faces; soft U at the floor.
  const valley = `M ${fmt(half)} ${fmt(half)} L ${fmt(mid)} ${fmt(h * 0.78)} L ${fmt(mW - half)} ${fmt(half)}`

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${viewW} ${h}`}
      width={size ?? "100%"}
      height={size ? undefined : "100%"}
      preserveAspectRatio="xMidYMid meet"
      shapeRendering="geometricPrecision"
      className={className}
      style={brandBoxStyle(style)}
      {...brandAria(title)}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      <rect x={0} y={0} width={b} height={h} rx={rx} fill="currentColor" />
      <rect x={mW - b} y={0} width={b} height={h} rx={rx} fill="currentColor" />
      <path
        d={valley}
        fill="none"
        stroke="currentColor"
        strokeWidth={b}
        strokeLinecap="butt"
        strokeLinejoin="round"
      />
      <rect x={iX} y={0} width={b} height={h} rx={rx} fill="currentColor" />
    </svg>
  )
})

/**
 * Geometric “A” — same bar weight as MI.
 * Chevron stroke (round tip) + rounded crossbar; clip → flat feet like stems.
 */
export const BrandLetterA = memo(function BrandLetterA({
  className,
  title,
  size,
  style,
  ...rest
}: BrandLetterProps) {
  const clipId = useId().replace(/:/g, "")
  const { bar: b, rx, height: h, aWidth: w } = BRAND_LETTER_CONFIG
  const half = b / 2
  const mid = w / 2
  const tipY = half
  // Extend past baseline; clipPath slices a clean horizontal foot.
  const footY = h + half
  const footL = half * 0.55
  const footR = w - half * 0.55

  const barTop = h * 0.56
  const barH = b * 0.8
  const barMidY = barTop + barH / 2
  const t = (barMidY - tipY) / (h - tipY)
  const legCxL = mid + (footL - mid) * t
  const legCxR = mid + (footR - mid) * t
  const overlap = half * 0.5
  const barX = legCxL - overlap
  const barW = legCxR - legCxL + overlap * 2

  const chevron = `M ${fmt(footL)} ${fmt(footY)} L ${fmt(mid)} ${fmt(tipY)} L ${fmt(footR)} ${fmt(footY)}`

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${w} ${h}`}
      width={size ?? "100%"}
      height={size ? undefined : "100%"}
      preserveAspectRatio="xMidYMid meet"
      shapeRendering="geometricPrecision"
      className={className}
      style={brandBoxStyle(style)}
      {...brandAria(title)}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <clipPath id={clipId}>
          <rect x={0} y={0} width={w} height={h} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <path
          d={chevron}
          fill="none"
          stroke="currentColor"
          strokeWidth={b}
          strokeLinecap="butt"
          strokeLinejoin="round"
        />
        {/* Tip disc — same round terminal mass as MI stem caps */}
        <circle cx={mid} cy={tipY} r={half} fill="currentColor" />
        <rect
          x={barX}
          y={barTop}
          width={barW}
          height={barH}
          rx={rx}
          fill="currentColor"
        />
      </g>
    </svg>
  )
})
