/**
 * Shared value-noise + glyph sampling for micro ASCII surfaces.
 */

export const ASCII_PALETTE = [" ", " ", " ", "·", ".", "-", ":", ";", "=", "+", "*", "#"]

/** Visible (non-space) glyphs from the ambient field — wordmark decode, crystal text. */
export const ASCII_FIELD_SCRAMBLE_GLYPHS = [
  ...new Set(ASCII_PALETTE.filter((ch) => ch !== " ")),
].join("")

/** Micro controls (burger ring) — same ink weight as the ambient field, no heavy %/@. */
export const ASCII_MICRO_PALETTE = [...new Set(ASCII_PALETTE.filter((ch) => ch !== " "))]

export function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0
  h = ((h ^ (h >>> 13)) * 1274126177) | 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

export function vnoise(x: number, y: number, t: number): number {
  const sx = x * 0.085 + t * 0.85
  const sy = y * 0.125 - t * 0.35
  const x0 = Math.floor(sx)
  const y0 = Math.floor(sy)
  const fx = sx - x0
  const fy = sy - y0
  const a = hash2(x0, y0)
  const b = hash2(x0 + 1, y0)
  const c = hash2(x0, y0 + 1)
  const d = hash2(x0 + 1, y0 + 1)
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const base = (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy
  const band = 0.1 * Math.sin(y * 0.09 + t * 0.6)
  return Math.max(0, Math.min(0.999, base + band))
}

export function glyphFor(v: number): string {
  const idx = Math.min(ASCII_PALETTE.length - 1, Math.floor(v * v * ASCII_PALETTE.length))
  return ASCII_PALETTE[idx]!
}

function hexToRgba(hex: string, alpha: number): string | null {
  const m6 = hex.match(/^#([0-9a-f]{6})$/i)
  if (m6) {
    const value = parseInt(m6[1]!, 16)
    return `rgba(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff}, ${alpha})`
  }
  const m3 = hex.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i)
  if (m3) {
    const r = parseInt(m3[1]! + m3[1], 16)
    const g = parseInt(m3[2]! + m3[2], 16)
    const b = parseInt(m3[3]! + m3[3], 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  return null
}

function rgbStringToRgba(rgb: string, alpha: number): string | null {
  const m = rgb.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (!m) return null
  return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`
}

export function readCssColorInk(cssVar: string, alpha: number, fallback: string): string {
  if (typeof document === "undefined") return fallback
  const probe = document.createElement("span")
  probe.style.color = `var(${cssVar})`
  probe.style.display = "none"
  document.documentElement.appendChild(probe)
  const resolved = getComputedStyle(probe).color
  probe.remove()
  return rgbStringToRgba(resolved, alpha) ?? hexToRgba(
    getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim(),
    alpha,
  ) ?? fallback
}
