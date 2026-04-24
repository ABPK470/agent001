/**
 * Shared helpers for chart rendering: number formatting, "nice" axis ticks,
 * and the colour palette. Pure functions — no React, no DOM.
 */

// ── Formatting ────────────────────────────────────────────────────

export type ValueFormat = "number" | "compact" | "percent" | "currency"

const SI_UNITS: Array<[number, string]> = [
  [1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"],
]

/** Format a number with optional precision + value-format hint. */
export function formatValue(
  value: number,
  format: ValueFormat = "number",
  precision = 2,
  unit?: string,
): string {
  if (!isFinite(value)) return "—"

  if (format === "percent") {
    return `${value.toFixed(precision)}%`
  }
  if (format === "currency") {
    const sign = value < 0 ? "-" : ""
    const abs = Math.abs(value)
    return `${sign}${unit ?? "$"}${formatCompact(abs, precision)}`
  }
  if (format === "compact") {
    return `${formatCompact(value, precision)}${unit ? ` ${unit}` : ""}`
  }
  // "number"
  const fixed = Number.isInteger(value) ? value.toString() : value.toFixed(precision)
  return `${fixed}${unit ? ` ${unit}` : ""}`
}

function formatCompact(value: number, precision: number): string {
  const sign = value < 0 ? "-" : ""
  const abs = Math.abs(value)
  for (const [div, suffix] of SI_UNITS) {
    if (abs >= div) {
      const v = abs / div
      const p = v >= 100 ? 0 : v >= 10 ? 1 : precision
      return `${sign}${v.toFixed(p)}${suffix}`
    }
  }
  if (Number.isInteger(abs)) return `${sign}${abs}`
  return `${sign}${abs.toFixed(precision)}`
}

/** Compact axis-tick formatter (always short, no unit suffix). */
export function formatTick(value: number): string {
  if (!isFinite(value)) return ""
  if (value === 0) return "0"
  const abs = Math.abs(value)
  if (abs < 0.01) return value.toExponential(1)
  if (abs < 1) return value.toFixed(2)
  return formatCompact(value, 1)
}

// ── Nice ticks (1-2-5 × 10^n) ────────────────────────────────────

/** Returns "nice" round tick values covering [min, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) {
    if (min === 0) return [0, 1]
    const pad = Math.abs(min) * 0.1
    return niceTicks(min - pad, max + pad, count)
  }
  if (min > max) [min, max] = [max, min]

  const range = max - min
  const rawStep = range / Math.max(count - 1, 1)
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)))
  const norm = rawStep / mag
  let step: number
  if (norm < 1.5) step = 1 * mag
  else if (norm < 3) step = 2 * mag
  else if (norm < 7) step = 5 * mag
  else step = 10 * mag

  const niceMin = Math.floor(min / step) * step
  const niceMax = Math.ceil(max / step) * step
  const ticks: number[] = []
  // Use a stable rounding step to avoid FP creep
  const decimals = Math.max(0, -Math.floor(Math.log10(step)))
  for (let v = niceMin; v <= niceMax + step / 2; v += step) {
    ticks.push(Number(v.toFixed(decimals + 6)))
  }
  return ticks
}

/** Returns [niceMin, niceMax] tightly rounded around the data range. */
export function niceDomain(min: number, max: number, count = 5): [number, number] {
  const ticks = niceTicks(min, max, count)
  return [ticks[0], ticks[ticks.length - 1]]
}

// ── Palette (matches existing UI tokens) ─────────────────────────

export const CHART_PALETTE = [
  "#7B6FC7", // accent (plum-violet)
  "#6CB4EE", // sky
  "#5db078", // success green
  "#d4a64a", // warning amber
  "#EA6248", // coral
  "#825776", // plum
  "#F49D6C", // peach
  "#9189D4", // accent-hover
  "#D17877", // rose
  "#a1a1aa", // muted
] as const

export function pickColor(index: number): string {
  return CHART_PALETTE[index % CHART_PALETTE.length]
}

/** Sequential single-hue scale 0..1 → rgba (used by heatmaps). */
export function sequentialColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t))
  // From near-base (low) to accent (high)
  const r = Math.round(28 + clamped * (123 - 28))
  const g = Math.round(28 + clamped * (111 - 28))
  const b = Math.round(35 + clamped * (199 - 35))
  return `rgb(${r}, ${g}, ${b})`
}

/** Diverging scale -1..1 → rgba (red-zero-blue). */
export function divergingColor(t: number): string {
  const clamped = Math.max(-1, Math.min(1, t))
  if (clamped >= 0) {
    // 0 → grey, +1 → blue
    const a = clamped
    return `rgb(${Math.round(45 + a * (108 - 45))}, ${Math.round(45 + a * (180 - 45))}, ${Math.round(45 + a * (238 - 45))})`
  }
  const a = -clamped
  // 0 → grey, -1 → coral
  return `rgb(${Math.round(45 + a * (234 - 45))}, ${Math.round(45 + a * (98 - 45))}, ${Math.round(45 + a * (72 - 45))})`
}
