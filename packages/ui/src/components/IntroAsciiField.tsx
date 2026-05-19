/**
 * IntroAsciiField — generative ASCII texture behind the /intro3 stage.
 *
 * Each cell's glyph is sampled from a slowly-drifting 2-D value-noise
 * field, so the surface forms organic blobs / horizontal bands instead
 * of pure white noise. Per frame a small fraction of cells repaint
 * themselves from the *current* noise — so as `t` drifts, visible
 * structure morphs in place.
 *
 * Glyph alphabet is a safe ASCII subset (`. · - = : ; + * # / \ |`),
 * weighted by noise value: low → spaces, high → dense glyphs. This is
 * what makes it read like a Codex-style ambient field rather than TV
 * static.
 *
 * Pointer-events:none, respects prefers-reduced-motion, DPR-aware.
 */

import { useEffect, useRef } from "react"

// Discrete ASCII palette ordered sparse → dense. Cell glyph is picked
// by noise bucket; the same noise value always maps to the same glyph
// so motion comes from the noise field drifting, not from re-randomising
// per cell.
const PALETTE = [" ", " ", " ", "·", ".", "-", ":", ";", "=", "+", "*", "#"]

const CHAR_W = 9
const LINE_H = 14
const FONT_PX = 12
const TARGET_FPS = 18
const UPDATE_FRACTION = 0.020       // ~2% of cells repaint per frame
const NOISE_T_PER_SEC = 0.32        // how fast the noise field drifts
const INK_OPACITY = 0.18            // applied to var(--text), works in both themes

function readInk(): string {
  if (typeof document === "undefined") return `rgba(120,120,120,${INK_OPACITY})`
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--text").trim()
  const m6 = raw.match(/^#([0-9a-f]{6})$/i)
  if (m6) {
    const v = parseInt(m6[1]!, 16)
    return `rgba(${(v >> 16) & 0xff}, ${(v >> 8) & 0xff}, ${v & 0xff}, ${INK_OPACITY})`
  }
  const m3 = raw.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i)
  if (m3) {
    const r = parseInt(m3[1]! + m3[1], 16)
    const g = parseInt(m3[2]! + m3[2], 16)
    const b = parseInt(m3[3]! + m3[3], 16)
    return `rgba(${r}, ${g}, ${b}, ${INK_OPACITY})`
  }
  return `rgba(120,120,120,${INK_OPACITY})`
}

// 2-D integer hash → [0,1). Stable, no allocations.
function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0
  h = ((h ^ (h >>> 13)) * 1274126177) | 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

// Value noise with cosine-smoothed bilinear interp + a horizontal band
// bias so the field has visible "weather" running across the screen.
function vnoise(x: number, y: number, t: number): number {
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
  // Horizontal band bias — slow vertical sine modulated by time.
  const band = 0.10 * Math.sin(y * 0.09 + t * 0.6)
  return Math.max(0, Math.min(0.999, base + band))
}

function glyphFor(v: number): string {
  // Map noise → palette index. Bias toward the sparse end so most of
  // the canvas reads as breathing space, dense glyphs concentrate in
  // crests.
  const idx = Math.min(PALETTE.length - 1, Math.floor(v * v * PALETTE.length))
  return PALETTE[idx]!
}

export function IntroAsciiField(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false

    let ink = readInk()
    let cols = 0
    let rows = 0
    let cells = new Uint8Array(0)   // last-painted palette index per cell
    let rafId = 0
    let lastFrame = 0
    let startTs = 0

    function paintCellAt(c: number, r: number, ch: string) {
      const x = c * CHAR_W
      const y = r * LINE_H
      ctx!.clearRect(x, y, CHAR_W, LINE_H)
      if (ch !== " ") ctx!.fillText(ch, x, y)
    }

    function repaintAll(t: number) {
      ctx!.clearRect(0, 0, canvas!.width / dpr, canvas!.height / dpr)
      ctx!.fillStyle = ink
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const v = vnoise(c, r, t)
          const idx = Math.min(PALETTE.length - 1, Math.floor(v * v * PALETTE.length))
          cells[r * cols + c] = idx
          const ch = PALETTE[idx]!
          if (ch !== " ") ctx!.fillText(ch, c * CHAR_W, r * LINE_H)
        }
      }
    }

    function resize() {
      const w = window.innerWidth
      const h = window.innerHeight
      canvas!.width = Math.floor(w * dpr)
      canvas!.height = Math.floor(h * dpr)
      canvas!.style.width = w + "px"
      canvas!.style.height = h + "px"
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx!.font = `${FONT_PX}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace`
      ctx!.textBaseline = "top"
      ctx!.fillStyle = ink

      cols = Math.ceil(w / CHAR_W) + 1
      rows = Math.ceil(h / LINE_H) + 1
      cells = new Uint8Array(cols * rows)
      const t = (performance.now() - startTs) / 1000 * NOISE_T_PER_SEC
      repaintAll(t)
    }

    function tick(now: number) {
      rafId = requestAnimationFrame(tick)
      const frameMs = 1000 / TARGET_FPS
      if (now - lastFrame < frameMs) return
      lastFrame = now

      const t = (now - startTs) / 1000 * NOISE_T_PER_SEC
      const total = cols * rows
      const updates = Math.max(48, Math.floor(total * UPDATE_FRACTION))
      ctx!.fillStyle = ink
      for (let i = 0; i < updates; i++) {
        const idx = (Math.random() * total) | 0
        const r = (idx / cols) | 0
        const c = idx - r * cols
        const v = vnoise(c, r, t)
        const palIdx = Math.min(PALETTE.length - 1, Math.floor(v * v * PALETTE.length))
        if (palIdx === cells[idx]) continue
        cells[idx] = palIdx
        paintCellAt(c, r, PALETTE[palIdx]!)
      }
    }

    function onThemeChange() {
      ink = readInk()
      const t = (performance.now() - startTs) / 1000 * NOISE_T_PER_SEC
      repaintAll(t)
    }

    startTs = performance.now()
    window.addEventListener("resize", resize)
    const themeObserver = new MutationObserver(onThemeChange)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
    // System theme (when site follows `prefers-color-scheme` indirectly)
    const sysMql = window.matchMedia?.("(prefers-color-scheme: dark)")
    sysMql?.addEventListener?.("change", onThemeChange)
    resize()
    if (!reduced) rafId = requestAnimationFrame(tick)

    return () => {
      window.removeEventListener("resize", resize)
      themeObserver.disconnect()
      sysMql?.removeEventListener?.("change", onThemeChange)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [])

  return <canvas ref={canvasRef} className="intro3-ascii-field" aria-hidden="true" />
}

// Exported so other components can scramble through the same alphabet
// and feel like they're coalescing out of the field.
export const ASCII_SCRAMBLE_GLYPHS = "·.-:;=+*#/\\|"
