/**
 * IntroAsciiField — 3D ASCII wave heightmap behind the /intro3 stage.
 *
 * TRUE perspective projection of a world-space wave surface (NOT just
 * stacked 2D sines):
 *
 *   • A virtual camera sits at world height CAM_HEIGHT looking along
 *     +z toward a horizon. Ribbons are evenly-spaced depth slices
 *     z ∈ [Z_NEAR, Z_FAR] projected to screen via
 *         screenY = horizonY + focal · (CAM_HEIGHT − waveY) / z
 *     Because depth divides amplitude, foreground waves tower over
 *     background ones automatically and ribbons cluster at the
 *     horizon — same math as a ground-plane texture.
 *
 *   • For each screen-x bucket we back-project to world-x at that
 *     depth  (worldX = (screenX − cx) · z / focal),  sample
 *     surface(worldX, z, t), then project back. Dot spacing on
 *     screen stays constant (clean halftone) but the underlying
 *     world sample spacing auto-scales with depth.
 *
 *   • Hidden-line removal: ribbons painted FRONT-to-BACK. A per-column
 *     "skyline" Float32Array tracks the topmost screen-y painted at
 *     each column; a back ribbon's dot is drawn only when it sticks
 *     UP above every closer ribbon at the same x — standard heightmap
 *     visibility rule, what makes ridges occlude valleys behind them.
 *
 *   • Glyph weight tracks depth (heavy near, sparse far) so ribbons
 *     read as scanlines and the field fades toward the horizon.
 *
 * Pointer-events:none, respects prefers-reduced-motion, DPR-aware.
 */

import { useEffect, useRef } from "react"

// Glyph palette ordered NEAR → FAR (heavy → sparse). Each ribbon
// picks one glyph based on its depth bucket so all dots in the same
// ribbon match — that's what makes ribbons read as scanlines.
const RIBBON_GLYPHS = ["#", "*", "*", "•", "•", ":", ":", "·", "·", "."]

const DOT_STEP_PX = 6                // screen-pixel spacing between dots inside a ribbon
const FONT_PX = 11
const TARGET_FPS = 18
const INK_OPACITY = 0.22             // applied to var(--text), works in both themes

// --- Virtual camera + scene (world units; wave amp ≈ 0.55 world units) ---
const RIBBON_COUNT = 130             // number of depth slices
const CAM_HEIGHT = 2.4               // camera height above the mean water plane
const FOCAL_FRAC = 0.85              // focal length as fraction of screen height
const HORIZON_FRAC = 0.22            // horizon line position (fraction of screen height from top)
// Ribbons are parameterized by SCREEN baseline (not world depth) via a
// power curve: baselineY = horizonY + u^BASELINE_POWER · (bottomY − horizonY).
//   1.0 = perfectly even spacing on screen (no horizon convergence)
//   2.0 = strong horizon clustering, even foreground gaps
//   3.0+ = ribbons crammed at the horizon, sparse foreground
// 1.8 gives clear vanishing-point convergence at the horizon AND keeps
// foreground ribbons close enough to read as a continuous surface
// (no big black bands). worldZ is derived from baselineY — see render.
const BASELINE_POWER = 1.8
const BASELINE_MIN_PX = 0.5          // floor so the i=0 ribbon doesn't project to z = +∞
const WAVE_AMP_WORLD = 0.55          // wave height amplitude in world units
const WAVE_SPEED = 0.45              // surface drift speed (seconds → phase units)

// Roll-out animation — radial "materialize" from screen centre, with
// per-ribbon jitter so it doesn't read as a clean radial wave.
const REVEAL_DURATION_MS = 900
const CENTER_BIAS = 0.55             // 0 = pure random, 1 = pure radial

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

/**
 * Surface elevation h(x, z, t) ∈ ~[-1, 1] in WORLD units — a sum of
 * three sinusoids mixing world-x, world-z, and time at different
 * rates. The z-coupled terms make ridges drift sideways as they
 * recede, so adjacent depth slices aren't vertically-offset copies of
 * the same curve. Frequencies chosen for wavelengths of roughly 3–10
 * world units (the visible scene spans worldZ ∈ [Z_NEAR, Z_FAR] ≈
 * 1–42 world units).
 */
function surface(x: number, z: number, t: number): number {
  const s1 = Math.sin(x * 0.62 + t * 0.95)                     // λ ≈ 10 units, fast drift
  const s2 = Math.sin(x * 0.31 - z * 0.48 + t * 0.70)          // diagonal ridges, medium drift
  const s3 = Math.sin((x * 0.17 + z * 0.34) - t * 0.45)        // long swells, slow drift
  return s1 * 0.50 + s2 * 0.32 + s3 * 0.22                     // ≈ [-1, 1]
}

export function IntroAsciiField({ onReady }: { onReady?: () => void } = {}) {
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
    let screenW = 0
    let screenH = 0
    let dotCols = 0                     // number of x-buckets across the screen
    let skyline = new Float32Array(0)   // per-bucket topmost screen-y painted so far (hidden-line)
    let ribbonRevealMs = new Float32Array(0)  // per-ribbon reveal time from start
    let revealed = false
    let rafId = 0
    let lastFrame = 0
    let startTs = 0

    function computeRevealTimes() {
      // Each ribbon reveals at a time blended between a radial centre-out
      // bias (CENTER_BIAS) and per-ribbon hash jitter, so the field
      // materialises everywhere at once with a soft outward focus pull
      // rather than a clean wavefront.
      const cMid = (RIBBON_COUNT - 1) / 2
      for (let i = 0; i < RIBBON_COUNT; i++) {
        const radial = Math.abs(i - cMid) / cMid                  // 0 (centre) → 1 (edges)
        const jitter = hash2(i * 131, 7)                          // [0, 1)
        const u = CENTER_BIAS * radial + (1 - CENTER_BIAS) * jitter
        ribbonRevealMs[i] = u * REVEAL_DURATION_MS
      }
    }

    /**
     * Render one frame using a true perspective camera. For each depth
     * slice z (ribbon, near→far), iterate screen-x buckets, back-project
     * to world-x at depth z, sample the wave surface, then project the
     * sample back to screen-y. Maintain a per-column skyline of the
     * topmost screen-y painted so far; a deeper sample is drawn only
     * when it sticks up above the skyline — i.e. it isn't occluded by
     * a closer ridge. Painted front-to-back so reveal gating composes
     * correctly with hidden-line removal.
     */
    function renderFrame(t: number, revealCutoffMs: number) {
      ctx!.clearRect(0, 0, screenW, screenH)
      ctx!.fillStyle = ink

      const focal = screenH * FOCAL_FRAC
      const horizonY = screenH * HORIZON_FRAC
      const bottomY = screenH
      const groundSpanPx = bottomY - horizonY
      const cx = screenW / 2

      // Skyline starts "below the screen" — every nearest-ribbon dot
      // wins on the first comparison.
      skyline.fill(screenH + 1)

      // Front-to-back: i = N-1 (nearest, bottom of screen) down to 0
      // (farthest, near horizon).
      //
      // Ribbons are spaced by SCREEN baseline rather than world depth:
      //   baselineOffset = u^BASELINE_POWER · groundSpanPx
      //   worldZ = focal · CAM_HEIGHT / baselineOffset    (inverse projection)
      // The power curve packs ribbons at the horizon (low u) while keeping
      // foreground rows close enough to fill the screen — fixes the big
      // black gaps you'd get from linear-in-z spacing where 1/z² makes
      // foreground gaps explode.
      for (let i = RIBBON_COUNT - 1; i >= 0; i--) {
        // Reveal gate: ribbons not yet at their reveal time are skipped.
        if (!revealed && revealCutoffMs < ribbonRevealMs[i]!) continue

        const u = i / (RIBBON_COUNT - 1)                 // 0 = nearest, 1 = farthest
        const baselineOffset = Math.max(
          BASELINE_MIN_PX,
          Math.pow(u, BASELINE_POWER) * groundSpanPx,
        )
        const baselineY = horizonY + baselineOffset
        const z = focal * CAM_HEIGHT / baselineOffset    // derived world depth
        const projScale = focal / z                       // px-per-world-unit at this depth

        // Glyph weight: heavy near (large u, bottom of screen) →
        // sparse far (u → 0, horizon). Palette is ordered NEAR→FAR.
        const gIdx = Math.min(
          RIBBON_GLYPHS.length - 1,
          Math.floor((1 - u) * RIBBON_GLYPHS.length),
        )
        const glyph = RIBBON_GLYPHS[gIdx]!

        // Per-ribbon time offset so adjacent slices aren't phase-locked.
        const tz = t + z * 0.08

        for (let b = 0; b < dotCols; b++) {
          const sx = b * DOT_STEP_PX
          // Back-project this screen-x to world-x at depth z. Inverse of
          // sx = cx + worldX · focal / z.
          const worldX = (sx - cx) * z / focal
          const waveY = surface(worldX, z, tz) * WAVE_AMP_WORLD
          // Forward-project: sy = horizonY + focal·(CAM_HEIGHT − waveY)/z
          //                     = baselineY − projScale·waveY
          const sy = baselineY - projScale * waveY
          if (sy < skyline[b]!) {
            skyline[b] = sy
            // textBaseline=top → nudge by half the font height so the
            // dot visually sits ON the surface line.
            ctx!.fillText(glyph, sx, sy - FONT_PX * 0.55)
          }
        }
      }
    }

    function resize(initial: boolean) {
      screenW = window.innerWidth
      screenH = window.innerHeight
      canvas!.width = Math.floor(screenW * dpr)
      canvas!.height = Math.floor(screenH * dpr)
      canvas!.style.width = screenW + "px"
      canvas!.style.height = screenH + "px"
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx!.font = `${FONT_PX}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace`
      ctx!.textBaseline = "top"
      ctx!.fillStyle = ink

      dotCols = Math.ceil(screenW / DOT_STEP_PX) + 1
      skyline = new Float32Array(dotCols)
      ribbonRevealMs = new Float32Array(RIBBON_COUNT)
      computeRevealTimes()

      if (!initial || reduced) {
        // On resize (or with reduced motion) snap to fully revealed —
        // don't replay the reveal on every viewport change.
        const t = (performance.now() - startTs) / 1000 * WAVE_SPEED
        revealed = true
        renderFrame(t, Infinity)
        onReadyRef.current?.()
      } else {
        ctx!.clearRect(0, 0, screenW, screenH)
      }
    }

    function tick(now: number) {
      rafId = requestAnimationFrame(tick)
      const frameMs = 1000 / TARGET_FPS
      if (now - lastFrame < frameMs) return
      lastFrame = now

      const t = (now - startTs) / 1000 * WAVE_SPEED
      const elapsed = now - startTs

      renderFrame(t, elapsed)

      if (!revealed && elapsed >= REVEAL_DURATION_MS) {
        revealed = true
        onReadyRef.current?.()
      }
    }

    function onThemeChange() {
      ink = readInk()
      ctx!.fillStyle = ink
      const t = (performance.now() - startTs) / 1000 * WAVE_SPEED
      renderFrame(t, revealed ? Infinity : (performance.now() - startTs))
    }

    startTs = performance.now()
    const onResize = () => resize(false)
    window.addEventListener("resize", onResize)
    const themeObserver = new MutationObserver(onThemeChange)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
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
