/**
 * Custom geometric MI / A for the login brand sequence.
 *
 * Cap = Logo colon. Stems lighter than colon blocks. Extended (wide) stance
 * so the word reads as a longer lockup — not a stubby mark.
 */

/** Logo.tsx colon block corner radius. */
export const BRAND_LETTER_RX = 2.5
/** Slightly chunky stem — still under Logo block width (10). */
export const BRAND_LETTER_BAR = 7.25
export const BRAND_LETTER_HEIGHT = 32

/** Extended word widths — longer horizontal lockup. */
export const BRAND_MI_VIEW_W = 48
export const BRAND_A_VIEW_W = 28

interface LetterProps {
  className?: string
}

/** Extended geometric “MI”. */
export function BrandLetterMi({ className }: LetterProps) {
  const b = BRAND_LETTER_BAR
  const rx = BRAND_LETTER_RX
  const h = BRAND_LETTER_HEIGHT
  const mW = 34
  const mid = mW / 2
  const iX = BRAND_MI_VIEW_W - b
  const valley = h * 0.7

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${BRAND_MI_VIEW_W} ${h}`}
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden
      className={["intro3-wm-letter", "intro3-wm-letter--mi", className].filter(Boolean).join(" ")}
    >
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
}

/** Extended geometric “A”. */
export function BrandLetterA({ className }: LetterProps) {
  const b = BRAND_LETTER_BAR
  const rx = BRAND_LETTER_RX
  const h = BRAND_LETTER_HEIGHT
  const w = BRAND_A_VIEW_W
  const mid = w / 2

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${w} ${h}`}
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden
      className={["intro3-wm-letter", "intro3-wm-letter--a", className].filter(Boolean).join(" ")}
    >
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
}
