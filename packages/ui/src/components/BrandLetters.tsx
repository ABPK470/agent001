/**
 * Geometric MI / A for the login brand lockup.
 *
 * Cap height matches Logo colon. Same stroke+rect geometry as the seated mark —
 * props/a11y/config only; do not “soften” the tip/valley without an explicit ask.
 */

import { memo, type CSSProperties, type SVGProps } from "react"

/** Lockup metrics — shared by intro CSS (`--wm-mi-w` / `--wm-a-w` ratios). */
export const BRAND_LETTER_CONFIG = {
  rx: 2.5,
  bar: 7.25,
  height: 32,
  miWidth: 48,
  aWidth: 28,
  /** Inner M stem span (before the I gap). */
  mInnerWidth: 34,
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

function brandBoxStyle(
  size: number | string | undefined,
  style: CSSProperties | undefined,
): CSSProperties {
  return {
    display: "block",
    flexShrink: 0,
    overflow: "visible",
    ...style,
  }
}

/** Geometric “MI”. */
export const BrandLetterMi = memo(function BrandLetterMi({
  className,
  title,
  size,
  style,
  ...rest
}: BrandLetterProps) {
  const { bar: b, rx, height: h, miWidth: viewW, mInnerWidth: mW } = BRAND_LETTER_CONFIG
  const mid = mW / 2
  const iX = viewW - b
  const valley = h * 0.7

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${viewW} ${h}`}
      width={size ?? "100%"}
      height={size ? undefined : "100%"}
      preserveAspectRatio="xMidYMid meet"
      shapeRendering="geometricPrecision"
      className={className}
      style={brandBoxStyle(size, style)}
      {...brandAria(title)}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      <rect x={0} y={0} width={b} height={h} rx={rx} fill="currentColor" />
      <rect x={mW - b} y={0} width={b} height={h} rx={rx} fill="currentColor" />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth={b}
        strokeLinecap="round"
        strokeLinejoin="round"
        d={`M ${b * 0.4} ${b * 0.4} L ${mid} ${valley} L ${mW - b * 0.4} ${b * 0.4}`}
      />
      <rect x={iX} y={0} width={b} height={h} rx={rx} fill="currentColor" />
    </svg>
  )
})

/** Geometric “A”. */
export const BrandLetterA = memo(function BrandLetterA({
  className,
  title,
  size,
  style,
  ...rest
}: BrandLetterProps) {
  const { bar: b, rx, height: h, aWidth: w } = BRAND_LETTER_CONFIG
  const mid = w / 2

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${w} ${h}`}
      width={size ?? "100%"}
      height={size ? undefined : "100%"}
      preserveAspectRatio="xMidYMid meet"
      shapeRendering="geometricPrecision"
      className={className}
      style={brandBoxStyle(size, style)}
      {...brandAria(title)}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth={b}
        strokeLinecap="round"
        strokeLinejoin="round"
        d={`M ${b * 0.3} ${h - b * 0.3} L ${mid} ${b * 0.35} L ${w - b * 0.3} ${h - b * 0.3}`}
      />
      <rect
        x={b * 0.7}
        y={h * 0.5}
        width={w - b * 1.4}
        height={b * 0.85}
        rx={rx}
        fill="currentColor"
      />
    </svg>
  )
})
