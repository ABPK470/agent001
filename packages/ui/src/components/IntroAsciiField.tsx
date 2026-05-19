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

// Roll-out animation — staggered-start L→R sweeps. Every band sweeps
// left-to-right at the same speed, but they don't all start at once:
// the BOTTOM band starts first, each band above it starts a fixed
// stagger later. The leading edge therefore forms a diagonal that
// originates at the bottom-left and runs up-right, so the bottom-right
// corner is the first part of the screen to be fully populated, then
// each row above completes in turn.
//
// Already-revealed cells keep evolving via ambient drift, so the
// bottom of the screen visibly thickens while the upper rows are
// still mid-sweep.
const BAND_ROWS = 3                  // visual thickness of one band
const BAND_SWEEP_MS = 700            // time for one band to sweep L→R
const BAND_STAGGER_MIN_MS = 70       // minimum gap between band starts
const REVEAL_TOTAL_TARGET_MS = 2300  // soft cap on full reveal

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

export function IntroAsciiField({ onReady }: { onReady?: () => void } = {}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady

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
    let bands = 0
    let cells = new Uint8Array(0)   // last-painted palette index per cell
    let painted = new Uint8Array(0) // 1 once a cell has been revealed
    let bandStagger = BAND_STAGGER_MIN_MS
    let firstActiveAnimBand = 0     // lowest k still mid-sweep
    let revealed = false
    let rafId = 0
    let lastFrame = 0
    let startTs = 0

    function paintCellAt(c: number, r: number, ch: string) {
      const x = c * CHAR_W
      const y = r * LINE_H
      ctx!.clearRect(x, y, CHAR_W, LINE_H)
      if (ch !== " ") ctx!.fillText(ch, x, y)
    }

    // band index k in animation order → canvas band index (top-to-bottom)
    // k=0 is the BOTTOM canvas band; k=bands-1 is the TOP canvas band.
    function canvasBandOf(k: number): number { return bands - 1 - k }

    function cellRevealMs(k: number, c: number): number {
      const sweep = cols > 1 ? (c / (cols - 1)) * BAND_SWEEP_MS : 0
      return k * bandStagger + sweep
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

    function resize(initial: boolean) {
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
      bands = Math.ceil(rows / BAND_ROWS)
      cells = new Uint8Array(cols * rows)
      painted = new Uint8Array(cols * rows)
      firstActiveAnimBand = 0
      // Compress the stagger on tall screens so total reveal lands near
      // the target, but never below the minimum — keeps the diagonal
      // leading edge clearly visible.
      bandStagger = Math.max(
        BAND_STAGGER_MIN_MS,
        bands > 1 ? (REVEAL_TOTAL_TARGET_MS - BAND_SWEEP_MS) / (bands - 1) : BAND_STAGGER_MIN_MS
      )

      if (!initial || reduced) {
        // After first sizing (or with reduced motion) snap to fully
        // revealed — don't replay the wave on every viewport change.
        const t = (performance.now() - startTs) / 1000 * NOISE_T_PER_SEC
        repaintAll(t)
        painted.fill(1)
        firstActiveAnimBand = bands
        if (!revealed) {
          revealed = true
          onReadyRef.current?.()
        }
      } else {
        ctx!.clearRect(0, 0, w, h)
      }
    }

    function tick(now: number) {
      rafId = requestAnimationFrame(tick)
      const frameMs = 1000 / TARGET_FPS
      if (now - lastFrame < frameMs) return
      lastFrame = now

      const t = (now - startTs) / 1000 * NOISE_T_PER_SEC

      // Staggered-start sweeps — walk only the bands currently in flight
      // in animation order (k=0 is the bottom band; k=bands-1 is the
      // top). Every band sweeps at the same speed; bottom starts first.
      if (!revealed) {
        const elapsed = now - startTs
        const lastStartedK = Math.min(bands - 1, Math.floor(elapsed / bandStagger))
        ctx!.fillStyle = ink
        let advanceFirst = true
        for (let k = firstActiveAnimBand; k <= lastStartedK; k++) {
          const canvasBand = canvasBandOf(k)
          const rowStart = canvasBand * BAND_ROWS
          const rowEnd = Math.min(rows, rowStart + BAND_ROWS)
          let bandDone = true
          for (let c = 0; c < cols; c++) {
            if (elapsed < cellRevealMs(k, c)) { bandDone = false; break }
            for (let r = rowStart; r < rowEnd; r++) {
              const idx = r * cols + c
              if (painted[idx]) continue
              const v = vnoise(c, r, t)
              const palIdx = Math.min(PALETTE.length - 1, Math.floor(v * v * PALETTE.length))
              cells[idx] = palIdx
              painted[idx] = 1
              const ch = PALETTE[palIdx]!
              if (ch !== " ") ctx!.fillText(ch, c * CHAR_W, r * LINE_H)
            }
          }
          if (bandDone && advanceFirst && k === firstActiveAnimBand) {
            firstActiveAnimBand = k + 1
          } else {
            advanceFirst = false
          }
        }
        if (firstActiveAnimBand >= bands) {
          revealed = true
          onReadyRef.current?.()
        }
      }

      // Ambient drift on already-revealed cells. We restrict it to the
      // canvas region [bottomFilledRow..rows-1] so it only affects the
      // stacked-up portion at the bottom while upper bands keep arriving.
      const filledBands = firstActiveAnimBand
      const bottomFilledRow = revealed ? 0 : Math.max(0, rows - filledBands * BAND_ROWS)
      const liveRows = rows - bottomFilledRow
      if (liveRows <= 0) return
      const updates = Math.max(48, Math.floor(cols * liveRows * UPDATE_FRACTION))
      ctx!.fillStyle = ink
      for (let i = 0; i < updates; i++) {
        const r = bottomFilledRow + ((Math.random() * liveRows) | 0)
        const c = (Math.random() * cols) | 0
        const idx = r * cols + c
        if (!painted[idx]) continue
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
      // Re-ink only cells that have already been revealed so the wave
      // stays intact even if the user toggles theme mid-roll.
      ctx!.fillStyle = ink
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c
          if (!painted[idx]) continue
          const palIdx = cells[idx]
          const ch = PALETTE[palIdx]!
          paintCellAt(c, r, ch)
        }
      }
      // Suppress unused-variable warning — t reserved for future use.
      void t
    }

    startTs = performance.now()
    const onResize = () => resize(false)
    window.addEventListener("resize", onResize)
    const themeObserver = new MutationObserver(onThemeChange)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
    // System theme (when site follows `prefers-color-scheme` indirectly)
    const sysMql = window.matchMedia?.("(prefers-color-scheme: dark)")
    sysMql?.addEventListener?.("change", onThemeChange)
    resize(true)
    rafId = requestAnimationFrame(tick)

    return () => {
      window.removeEventListener("resize", onResize)
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
