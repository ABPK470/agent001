/**
 * IntroAsciiField — generative ASCII texture behind the login stage.
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

declare global {
  interface Window {
    __miaIntroAsciiStartTs?: number
  }
}

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
const BOOST_INK_OPACITY = 0.34

// Roll-out animation — non-directional "materialize". Every cell has
// its own stable reveal time computed from a per-cell hash blended
// with a soft center-outward bias. There is no sweep direction — the
// field appears everywhere at once with focus gently pulling outward
// from the screen center, and per-cell jitter keeps it from looking
// like a clean radial wave. Already-revealed cells immediately join
// the ambient noise drift so the surface feels alive from the first
// frame, not after a hard wavefront passes.
const REVEAL_DURATION_MS = 900       // time from first to last cell appearing
const CENTER_BIAS = 0.30             // 0 = pure random, 1 = pure radial
const REVEAL_SOFT_EDGE_MS = 120      // per-cell fade-in window (alpha ramp)

export type IntroAsciiTargetStage = "hidden" | "pill" | "copy"
export type IntroAsciiTargetMode = "activity" | "frame"
export type IntroAsciiSurface = "default" | "home"

export interface IntroAsciiRenderTarget {
  left: number
  top: number
  width: number
  height: number
  stage: IntroAsciiTargetStage
  mode: IntroAsciiTargetMode
  radius?: number
  progress?: number
}

function mirroredSurfaceColumn(surface: IntroAsciiSurface, c: number, cols: number): number {
  if (surface !== "home") return c
  return c < cols * 0.5 ? cols - 1 - c : c
}

function isMirroredHomeSurface(surface: IntroAsciiSurface): boolean {
  return false
}

function surfaceNoise(
  surface: IntroAsciiSurface,
  c: number,
  r: number,
  cols: number,
  rows: number,
  t: number,
): number {
  const base = vnoise(c, r, t)
  if (surface !== "home") return base

  // The new-chat home surface must read the same on the left and the
  // right. Sample the entire left half from mirrored right-half
  // coordinates so the home background is horizontally symmetric.
  const sampleC = mirroredSurfaceColumn(surface, c, cols)
  const primary = vnoise(sampleC, r, t)
  const detail = vnoise(sampleC * 0.61 + 23, r * 0.74 + 17, t * 0.86 + 4.2)
  return Math.max(0, Math.min(0.999, primary * 0.84 + detail * 0.16))
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function roundedRectSdf(px: number, py: number, target: IntroAsciiRenderTarget): number {
  const radius = Math.min(target.radius ?? 24, target.width / 2, target.height / 2)
  const cx = target.left + target.width / 2
  const cy = target.top + target.height / 2
  const qx = Math.abs(px - cx) - (target.width / 2 - radius)
  const qy = Math.abs(py - cy) - (target.height / 2 - radius)
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - radius
}

function readInk(alpha = INK_OPACITY): string {
  if (typeof document === "undefined") return `rgba(120,120,120,${alpha})`
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--text").trim()
  const m6 = raw.match(/^#([0-9a-f]{6})$/i)
  if (m6) {
    const v = parseInt(m6[1]!, 16)
    return `rgba(${(v >> 16) & 0xff}, ${(v >> 8) & 0xff}, ${v & 0xff}, ${alpha})`
  }
  const m3 = raw.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i)
  if (m3) {
    const r = parseInt(m3[1]! + m3[1], 16)
    const g = parseInt(m3[2]! + m3[2], 16)
    const b = parseInt(m3[3]! + m3[3], 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  return `rgba(120,120,120,${alpha})`
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

export function IntroAsciiField({
  onReady,
  boost = false,
  renderTarget,
  surface = "default",
}: { onReady?: () => void; boost?: boolean; renderTarget?: IntroAsciiRenderTarget; surface?: IntroAsciiSurface } = {}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const onReadyRef = useRef(onReady)
  const renderTargetRef = useRef(renderTarget)
  onReadyRef.current = onReady
  renderTargetRef.current = renderTarget

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false

    // Boost mode — same noise field, just painted *hotter* and *more
    // alive*. Used for the local pill-area focus during the entering
    // morph so the user reads it as the existing ASCII becoming denser
    // and more active around the pill, not as a new layer.
    const palettePow = boost ? 1.0 : 2.0       // lower exponent → fewer spaces
    const updateFraction = boost ? 0.10 : UPDATE_FRACTION  // ~5× shimmer
    // In boost mode the field is mounted fresh per entering, so let
    // it materialize per-cell like the bg field does on first load.
    // Faster duration + pure-jitter ordering (no center bias) so the
    // cells appear randomly within whatever region the mask shows.
    const skipReveal = false
    const revealDuration = boost ? 600 : REVEAL_DURATION_MS
    const centerBias = boost ? 0 : CENTER_BIAS

    let ink = readInk(boost ? BOOST_INK_OPACITY : INK_OPACITY)
    let cols = 0
    let rows = 0
    let cells = new Uint8Array(0)   // last-painted palette index per cell
    let painted = new Uint8Array(0) // 1 once a cell has been revealed
    let revealTimes = new Float32Array(0) // per-cell reveal ms from start
    let revealed = false
    let rafId = 0
    let lastFrame = 0
    let startTs = 0
    let forceFullRepaint = false
    const stageState = {
      mode: renderTargetRef.current?.mode,
      stage: renderTargetRef.current?.stage,
      phaseStartTs: performance.now(),
    }
    // revealStartTs is ALWAYS local-to-this-mount so the per-cell
    // materialize replays each time the field mounts (boost field
    // mounts mid-session and needs a fresh organic appearance). The
    // shared startTs is only used for noise sampling so multiple
    // instances line up exactly.
    const revealStartTs = performance.now()

    function paintCellAt(c: number, r: number, ch: string, alpha = 1) {
      const x = c * CHAR_W
      const y = r * LINE_H
      ctx!.clearRect(x, y, CHAR_W, LINE_H)
      if (ch !== " " && alpha > 0.001) {
        if (alpha < 0.999) ctx!.globalAlpha = alpha
        ctx!.fillText(ch, x, y)
        if (alpha < 0.999) ctx!.globalAlpha = 1
      }
    }

    function cellAlpha(c: number, r: number, now: number): number {
      const target = renderTargetRef.current
      if (!target) return 1

      if (target.mode !== stageState.mode || target.stage !== stageState.stage) {
        stageState.mode = target.mode
        stageState.stage = target.stage
        stageState.phaseStartTs = now
        forceFullRepaint = true
      }

      const px = c * CHAR_W + CHAR_W * 0.5
      const py = r * LINE_H + LINE_H * 0.5
      const jitter = 0.82 + hash2(c + 97, r + 31) * 0.18

      if (target.mode === "activity") {
        if (target.stage === "copy") return 0
        const progress = clamp01(target.progress ?? (target.stage === "pill" ? 1 : 0))
        const cx = target.left + target.width / 2
        const cy = target.top + target.height / 2
        const dx = (px - cx) / Math.max(1, target.width * 0.7)
        const dy = (py - cy) / Math.max(1, target.height * 1.08)
        const dist = Math.sqrt(dx * dx + dy * dy)
        const primaryNoise = vnoise(c * 0.72 + 19, r * 0.84 + 31, now * 0.00042 + progress * 0.55)
        const filamentNoise = vnoise(c * 1.8 + 73, r * 1.34 + 11, now * 0.00076 + progress * 1.3)
        const radius = lerp(1.22, 0.42, progress)
        const softness = lerp(0.42, 0.16, progress)
        const warp = (primaryNoise - 0.5) * lerp(0.62, 0.2, progress) + (filamentNoise - 0.5) * 0.18
        const warpedDist = dist + warp
        const envelope = 1 - smoothstep(radius - softness, radius + softness, warpedDist)
        const density = smoothstep(
          lerp(0.78, 0.52, progress),
          lerp(1.06, 0.82, progress),
          envelope + primaryNoise * 0.42 + filamentNoise * 0.18 - (1 - progress) * 0.22,
        )
        const stageGain = lerp(0.14, 0.96, progress)
        return density * stageGain * jitter
      }

      if (target.stage !== "pill") return 0
      const elapsed = now - stageState.phaseStartTs
      const progress = clamp01(elapsed / 680)
      const sdf = roundedRectSdf(px, py, target)
      const ringWidth = lerp(24, 7, progress)
      const ring = 1 - smoothstep(ringWidth * 0.15, ringWidth * 1.35, Math.abs(sdf))
      const dissolve = 1 - smoothstep(0.18, 1, progress)
      return ring * dissolve * jitter
    }

    function computeRevealTimes() {
      const cx = cols / 2
      const cy = rows / 2
      const radialNorm = Math.sqrt(cx * cx + cy * cy) || 1
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const sampleC = mirroredSurfaceColumn(surface, c, cols)
          const dx = c - cx
          const dy = r - cy
          const radial = Math.sqrt(dx * dx + dy * dy) / radialNorm  // 0..~1
          const jitter = hash2(sampleC, r)                           // [0,1)
          const u = centerBias * radial + (1 - centerBias) * jitter
          revealTimes[r * cols + c] = u * revealDuration
        }
      }
    }


    function repaintAll(t: number) {
      ctx!.clearRect(0, 0, canvas!.width / dpr, canvas!.height / dpr)
      ctx!.fillStyle = ink
      for (let r = 0; r < rows; r++) {
        const startC = isMirroredHomeSurface(surface) ? Math.floor(cols * 0.5) : 0
        for (let c = startC; c < cols; c++) {
          const v = surfaceNoise(surface, c, r, cols, rows, t)
          const idx = Math.min(PALETTE.length - 1, Math.floor(Math.pow(v, palettePow) * PALETTE.length))
          cells[r * cols + c] = idx
          const ch = PALETTE[idx]!
          const alpha = cellAlpha(c, r, performance.now())
          if (ch !== " " && alpha > 0.001) paintCellAt(c, r, ch, alpha)

          if (isMirroredHomeSurface(surface)) {
            const mirrorC = cols - 1 - c
            cells[r * cols + mirrorC] = idx
            const mirrorAlpha = cellAlpha(mirrorC, r, performance.now())
            if (ch !== " " && mirrorAlpha > 0.001) paintCellAt(mirrorC, r, ch, mirrorAlpha)
          }
        }
      }
    }

    function measureSurface() {
      if (renderTargetRef.current && canvas!.parentElement instanceof HTMLElement) {
        const rect = canvas!.parentElement.getBoundingClientRect()
        return {
          width: Math.max(0, rect.width),
          height: Math.max(0, rect.height),
        }
      }

      return {
        width: window.innerWidth,
        height: window.innerHeight,
      }
    }

    function resize(initial: boolean) {
      const surface = measureSurface()
      const w = surface.width
      const h = surface.height
      if (w <= 0 || h <= 0) return
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
      painted = new Uint8Array(cols * rows)
      revealTimes = new Float32Array(cols * rows)
      computeRevealTimes()

      if (!initial || reduced || skipReveal) {
        // After first sizing (or with reduced motion, or in boost mode
        // where the bg field is already revealed) snap to fully
        // revealed — don't replay the wave.
        const t = (performance.now() - startTs) / 1000 * NOISE_T_PER_SEC
        repaintAll(t)
        painted.fill(1)
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
      if (forceFullRepaint) {
        forceFullRepaint = false
        repaintAll(t)
      }

      // Per-cell materialize. While the field is rolling out we walk
      // every cell once per frame and reveal any whose per-cell time
      // has elapsed. Newly-revealed cells get a short alpha ramp so
      // they fade in instead of popping — that's what kills the
      // "wavefront" look the directional sweep had.
      if (!revealed) {
        const elapsed = now - revealStartTs
        let anyPending = false
        ctx!.fillStyle = ink
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const idx = r * cols + c
            if (painted[idx]) continue
            const rt = revealTimes[idx]!
            if (elapsed < rt) { anyPending = true; continue }
            const v = surfaceNoise(surface, c, r, cols, rows, t)
            const palIdx = Math.min(PALETTE.length - 1, Math.floor(Math.pow(v, palettePow) * PALETTE.length))
            cells[idx] = palIdx
            painted[idx] = 1
            const ch = PALETTE[palIdx]!
            if (ch !== " ") {
              const targetAlpha = cellAlpha(c, r, now)
              if (targetAlpha <= 0.001) continue
              // Soft per-cell fade-in (one-shot — subsequent ambient
              // updates use full ink). Cheap because each cell only
              // gets one of these paints in its lifetime.
              const age = elapsed - rt
              const alpha = age >= REVEAL_SOFT_EDGE_MS
                ? 1
                : Math.max(0, age / REVEAL_SOFT_EDGE_MS)
              paintCellAt(c, r, ch, alpha * targetAlpha)
            }

            if (surface === "home") {
              const mirrorC = cols - 1 - c
              const mirrorIdx = r * cols + mirrorC
              if (!painted[mirrorIdx]) {
                cells[mirrorIdx] = palIdx
                painted[mirrorIdx] = 1
                if (ch !== " ") {
                  paintCellAt(mirrorC, r, ch, alpha * cellAlpha(mirrorC, r, now))
                }
              }
            }
          }
        }
        // After REVEAL_DURATION_MS + the soft edge, everything that
        // was going to land has landed (some cells with mid-jitter
        // landed earlier; we just need the last ones to finish their
        // fade-in before switching off the per-cell pass).
        if (!anyPending && elapsed >= revealDuration + REVEAL_SOFT_EDGE_MS) {
          revealed = true
          onReadyRef.current?.()
        }
      }

      // Ambient drift on already-revealed cells. During reveal this
      // hits whatever is already painted (which is scattered across
      // the whole screen, not stuck to one edge), so the field feels
      // alive from the very first frame.
      const updates = Math.max(48, Math.floor(cols * rows * updateFraction))
      ctx!.fillStyle = ink
      for (let i = 0; i < updates; i++) {
        const r = (Math.random() * rows) | 0
        const c = surface === "home"
          ? Math.max(Math.floor(cols * 0.5), (Math.random() * cols) | 0)
          : (Math.random() * cols) | 0
        const idx = r * cols + c
        if (!painted[idx]) continue
        const v = surfaceNoise(surface, c, r, cols, rows, t)
        const palIdx = Math.min(PALETTE.length - 1, Math.floor(Math.pow(v, palettePow) * PALETTE.length))
        if (palIdx === cells[idx]) continue
        cells[idx] = palIdx
        paintCellAt(c, r, PALETTE[palIdx]!, cellAlpha(c, r, now))

        if (surface === "home") {
          const mirrorC = cols - 1 - c
          const mirrorIdx = r * cols + mirrorC
          cells[mirrorIdx] = palIdx
          if (painted[mirrorIdx]) {
            paintCellAt(mirrorC, r, PALETTE[palIdx]!, cellAlpha(mirrorC, r, now))
          }
        }
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
          paintCellAt(c, r, ch, cellAlpha(c, r, performance.now()))
        }
      }
      // Suppress unused-variable warning — t reserved for future use.
      void t
    }

    // Share startTs across every IntroAsciiField mount on the page so
    // multiple instances (e.g. login overlay + chat-home veil + chat-home
    // masked) render the exact same noise field at any given moment.
    // That visual identity is what makes the materialize → veil → carved
    // hand-off feel like one continuous surface instead of three layers.
    if (typeof window.__miaIntroAsciiStartTs !== "number") {
      window.__miaIntroAsciiStartTs = performance.now()
    }
    startTs = window.__miaIntroAsciiStartTs
    const onResize = () => resize(false)
    window.addEventListener("resize", onResize)
    const parentObserver = canvas.parentElement instanceof HTMLElement
      ? new ResizeObserver(() => resize(false))
      : null
    if (parentObserver && canvas.parentElement instanceof HTMLElement) {
      parentObserver.observe(canvas.parentElement)
    }
    const themeObserver = new MutationObserver(onThemeChange)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
    // System theme (when site follows `prefers-color-scheme` indirectly)
    const sysMql = window.matchMedia?.("(prefers-color-scheme: dark)")
    sysMql?.addEventListener?.("change", onThemeChange)
    resize(true)
    rafId = requestAnimationFrame(tick)

    return () => {
      window.removeEventListener("resize", onResize)
      parentObserver?.disconnect()
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
