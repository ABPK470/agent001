/**
 * IntroAsciiField — generative ASCII texture behind the /intro3 stage.
 *
 * The field is 3-D value noise (z axis = time, so it morphs in place
 * with no global drift) sampled through DOMAIN WARPING: the (x, y)
 * coordinates fed into the noise are themselves perturbed by a second,
 * slower, lower-frequency noise. The result is curling tendrils and
 * organic pockets that fold and unfold — reads as smoke, aurora, or
 * ink in water rather than a regular noise field or a sonar ping.
 *
 * Glyph alphabet is a safe ASCII subset (`. · - = : ; + * # / \ |`),
 * weighted by field value: low → spaces, high → dense glyphs.
 *
 * Pointer-events:none, respects prefers-reduced-motion, DPR-aware.
 */

import { useEffect, useRef } from "react"

// Discrete ASCII palette ordered sparse → dense. Cell glyph is picked
// by noise bucket; the same noise value always maps to the same glyph
// so motion comes from the noise field drifting, not from re-randomising
// per cell. One leading space keeps a little breathing room in valleys
// without making the surface look empty.
const PALETTE = [" ", "·", ".", "-", ":", ";", "=", "+", "*", "#"]

const CHAR_W = 9
const LINE_H = 14
const FONT_PX = 12
const TARGET_FPS = 18
const UPDATE_FRACTION = 0.060       // ~6% of cells repaint per frame
const NOISE_T_PER_SEC = 1.10        // how fast the noise field morphs (z-axis lattice)
const NOISE_SX = 0.10               // horizontal noise frequency (per cell)
const NOISE_SY = 0.14               // vertical noise frequency (per cell)
const INK_OPACITY = 0.22            // applied to var(--text), works in both themes

// ── Domain warping (pattern: smoke / aurora) ────────────────────────
// The (x, y) sample position is offset by a second, slower, lower-
// frequency noise before being fed into the main noise. This bends
// what would be regular blobs into curling tendrils and folded pockets
// that drift and reform — no center, no rings, no flow direction.
const WARP_STRENGTH = 6.0           // how far (in cells) the sample is pushed by the warp
const WARP_FREQ = 0.045             // spatial frequency of the warp field (lower = bigger swirls)
const WARP_T_PER_SEC = 0.45         // how fast the warp itself evolves (slower than main noise)

// Density curve applied to raw noise before bucketing into the palette.
// 1.0 = linear (full surface), 2.0 = v² (very sparse), in between =
// somewhere full but still breathy. 1.35 reads as a dense organic field
// where peaks are obvious but the canvas is mostly populated.
const DENSITY_EXP = 1.35
function densityCurve(v: number): number {
  return Math.pow(v, DENSITY_EXP)
}

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

// 2-D integer hash → [0,1). Stable, no allocations. Used by reveal-time
// jitter (not by the noise field itself, which uses hash3).
function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0
  h = ((h ^ (h >>> 13)) * 1274126177) | 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

// 3-D integer hash → [0,1). The z axis is time-as-lattice-coordinate,
// which is what lets the field morph in place instead of scrolling.
function hash3(x: number, y: number, z: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 1442695040) | 0
  h = ((h ^ (h >>> 13)) * 1274126177) | 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

// 3-D value noise with cosine-smoothed trilinear interp. Sampling
// position (sx, sy) is FIXED per cell — only the z slice (tz) advances
// with time. As tz crosses each integer the field smoothly blends to
// a fresh independent noise frame, so blobs grow/dissolve/reshape in
// place with no global flow direction.
function vnoise(x: number, y: number, t: number): number {
  const sx = x * NOISE_SX
  const sy = y * NOISE_SY
  const tz = t                       // t is already scaled by NOISE_T_PER_SEC by the caller
  const x0 = Math.floor(sx)
  const y0 = Math.floor(sy)
  const z0 = Math.floor(tz)
  const fx = sx - x0
  const fy = sy - y0
  const fz = tz - z0
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const uz = fz * fz * (3 - 2 * fz)
  const c000 = hash3(x0,     y0,     z0)
  const c100 = hash3(x0 + 1, y0,     z0)
  const c010 = hash3(x0,     y0 + 1, z0)
  const c110 = hash3(x0 + 1, y0 + 1, z0)
  const c001 = hash3(x0,     y0,     z0 + 1)
  const c101 = hash3(x0 + 1, y0,     z0 + 1)
  const c011 = hash3(x0,     y0 + 1, z0 + 1)
  const c111 = hash3(x0 + 1, y0 + 1, z0 + 1)
  const x00 = c000 * (1 - ux) + c100 * ux
  const x10 = c010 * (1 - ux) + c110 * ux
  const x01 = c001 * (1 - ux) + c101 * ux
  const x11 = c011 * (1 - ux) + c111 * ux
  const y0v = x00 * (1 - uy) + x10 * uy
  const y1v = x01 * (1 - uy) + x11 * uy
  const v = y0v * (1 - uz) + y1v * uz
  return Math.max(0, Math.min(0.999, v))
}

function glyphFor(v: number): string {
  // Map noise → palette index via densityCurve. Lower DENSITY_EXP biases
  // the surface fuller; higher biases it sparser.
  const idx = Math.min(PALETTE.length - 1, Math.floor(densityCurve(v) * PALETTE.length))
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
    let cells = new Uint8Array(0)   // last-painted palette index per cell
    let painted = new Uint8Array(0) // 1 once a cell has been revealed
    let revealTimes = new Float32Array(0) // per-cell reveal ms from start
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

    // Domain-warped sample: offset the (c, r) lookup by a second,
    // slower noise so the field develops curling tendrils instead of
    // round blobs. tNoise is the z-axis time already scaled by
    // NOISE_T_PER_SEC; tSec is real elapsed seconds, used (slower) by
    // the warp layer so the swirls evolve at their own pace.
    function field(c: number, r: number, tNoise: number, tSec: number): number {
      const wt = tSec * WARP_T_PER_SEC
      // Two independent warp samples (offset lattice positions) give us
      // dx and dy. Centered on 0 so the warp pushes in all directions.
      const wx = (vnoise(c * (WARP_FREQ / NOISE_SX), r * (WARP_FREQ / NOISE_SY), wt) - 0.5) * 2
      const wy = (vnoise((c + 137) * (WARP_FREQ / NOISE_SX), (r + 311) * (WARP_FREQ / NOISE_SY), wt + 4.7) - 0.5) * 2
      const v = vnoise(c + wx * WARP_STRENGTH, r + wy * WARP_STRENGTH, tNoise)
      return v
    }

    function computeRevealTimes() {
      const cx = cols / 2
      const cy = rows / 2
      const radialNorm = Math.sqrt(cx * cx + cy * cy) || 1
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const dx = c - cx
          const dy = r - cy
          const radial = Math.sqrt(dx * dx + dy * dy) / radialNorm  // 0..~1
          const jitter = hash2(c, r)                                 // [0,1)
          const u = CENTER_BIAS * radial + (1 - CENTER_BIAS) * jitter
          revealTimes[r * cols + c] = u * REVEAL_DURATION_MS
        }
      }
    }

    function repaintAll(t: number) {
      ctx!.clearRect(0, 0, canvas!.width / dpr, canvas!.height / dpr)
      ctx!.fillStyle = ink
      const tSec = t / NOISE_T_PER_SEC
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const v = field(c, r, t, tSec)
          const idx = Math.min(PALETTE.length - 1, Math.floor(densityCurve(v) * PALETTE.length))
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
      cells = new Uint8Array(cols * rows)
      painted = new Uint8Array(cols * rows)
      revealTimes = new Float32Array(cols * rows)
      computeRevealTimes()

      if (!initial || reduced) {
        // After first sizing (or with reduced motion) snap to fully
        // revealed — don't replay the wave on every viewport change.
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
      const tSec = (now - startTs) / 1000

      // Per-cell materialize. While the field is rolling out we walk
      // every cell once per frame and reveal any whose per-cell time
      // has elapsed. Newly-revealed cells get a short alpha ramp so
      // they fade in instead of popping — that's what kills the
      // "wavefront" look the directional sweep had.
      if (!revealed) {
        const elapsed = now - startTs
        let anyPending = false
        ctx!.fillStyle = ink
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const idx = r * cols + c
            if (painted[idx]) continue
            const rt = revealTimes[idx]!
            if (elapsed < rt) { anyPending = true; continue }
            const v = field(c, r, t, tSec)
            const palIdx = Math.min(PALETTE.length - 1, Math.floor(densityCurve(v) * PALETTE.length))
            cells[idx] = palIdx
            painted[idx] = 1
            const ch = PALETTE[palIdx]!
            if (ch !== " ") {
              // Soft per-cell fade-in (one-shot — subsequent ambient
              // updates use full ink). Cheap because each cell only
              // gets one of these paints in its lifetime.
              const age = elapsed - rt
              const alpha = age >= REVEAL_SOFT_EDGE_MS
                ? 1
                : Math.max(0, age / REVEAL_SOFT_EDGE_MS)
              if (alpha < 1) {
                ctx!.globalAlpha = alpha
                ctx!.fillText(ch, c * CHAR_W, r * LINE_H)
                ctx!.globalAlpha = 1
              } else {
                ctx!.fillText(ch, c * CHAR_W, r * LINE_H)
              }
            }
          }
        }
        // After REVEAL_DURATION_MS + the soft edge, everything that
        // was going to land has landed (some cells with mid-jitter
        // landed earlier; we just need the last ones to finish their
        // fade-in before switching off the per-cell pass).
        if (!anyPending && elapsed >= REVEAL_DURATION_MS + REVEAL_SOFT_EDGE_MS) {
          revealed = true
          onReadyRef.current?.()
        }
      }

      // Ambient drift on already-revealed cells. During reveal this
      // hits whatever is already painted (which is scattered across
      // the whole screen, not stuck to one edge), so the field feels
      // alive from the very first frame.
      const updates = Math.max(48, Math.floor(cols * rows * UPDATE_FRACTION))
      ctx!.fillStyle = ink
      for (let i = 0; i < updates; i++) {
        const r = (Math.random() * rows) | 0
        const c = (Math.random() * cols) | 0
        const idx = r * cols + c
        if (!painted[idx]) continue
        const v = field(c, r, t, tSec)
        const palIdx = Math.min(PALETTE.length - 1, Math.floor(densityCurve(v) * PALETTE.length))
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
