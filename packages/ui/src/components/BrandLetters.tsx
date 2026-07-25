/**
 * Custom geometric MI / A — login wordmark.
 *
 * Coder-style logotype mechanics (not their look):
 * wide-set bold geometric letters, flat cap/baseline, tight even tracking,
 * mark (our colon) at exact cap height. Solid fills — reads as a logo, not sticks.
 */

export const BRAND_LETTER_RX = 2.5
/** Bold but open — logo weight, not ultra-black. */
export const BRAND_LETTER_BAR = 7.5
/** Slightly squat grid so glyphs feel wide-set (Coder proportion lesson). */
export const BRAND_LETTER_HEIGHT = 28

export const BRAND_MI_VIEW_W = 50
export const BRAND_A_VIEW_W = 30

interface LetterProps {
  className?: string
}

/** Wide-set geometric “MI”. */
export function BrandLetterMi({ className }: LetterProps) {
  const b = BRAND_LETTER_BAR
  const rx = BRAND_LETTER_RX
  const h = BRAND_LETTER_HEIGHT
  const mW = 36
  const mid = mW / 2
  const iX = BRAND_MI_VIEW_W - b
  const valley = h * 0.74

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
      {/* Solid M — one silhouette, open crotch (type-like, not bar collage). */}
      <path
        fill="currentColor"
        d={[
          `M 0 ${h}`,
          `V 0`,
          `H ${b}`,
          `L ${mid} ${valley}`,
          `L ${mW - b} 0`,
          `H ${mW}`,
          `V ${h}`,
          `H ${mW - b}`,
          `V ${h * 0.4}`,
          `L ${mid} ${h - b * 0.25}`,
          `L ${b} ${h * 0.4}`,
          `V ${h}`,
          "Z",
        ].join(" ")}
      />
      <rect x={iX} y={0} width={b} height={h} rx={rx} fill="currentColor" />
    </svg>
  )
}

/** Wide-set geometric “A” with open counter. */
export function BrandLetterA({ className }: LetterProps) {
  const b = BRAND_LETTER_BAR
  const h = BRAND_LETTER_HEIGHT
  const w = BRAND_A_VIEW_W
  const mid = w / 2
  const apex = b * 0.42
  // Inner counter — evenodd cut so it reads as type, not a solid chevron.
  const innerTop = b * 1.55
  const innerBot = h * 0.48
  const innerHalf = b * 0.55

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
        fill="currentColor"
        fillRule="evenodd"
        d={[
          // Outer A
          `M 0 ${h}`,
          `L ${mid - apex} 0`,
          `H ${mid + apex}`,
          `L ${w} ${h}`,
          `H ${w - b}`,
          `L ${mid} ${b * 1.2}`,
          `L ${b} ${h}`,
          "Z",
          // Counter
          `M ${mid} ${innerTop}`,
          `L ${mid + innerHalf} ${innerBot}`,
          `H ${mid - innerHalf}`,
          "Z",
        ].join(" ")}
      />
      <rect
        x={b * 0.95}
        y={h * 0.58}
        width={w - b * 1.9}
        height={b * 0.9}
        rx={BRAND_LETTER_RX}
        fill="currentColor"
      />
    </svg>
  )
}
