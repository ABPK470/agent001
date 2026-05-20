/**
 * IntroAsciiField — visual representation of an AI agentic system,
 * ready to be plugged into any substrate.
 *
 * Three layers, read from back to front:
 *
 *   1. SUBSTRATE — a quiet, near-static lattice of low-density ASCII
 *      marks sampled from a sparse 2-D value-noise field. Density is
 *      capped so the substrate alone never climbs past `·` / `.` —
 *      it reads as a calm field of points, the kind of thing an agent
 *      could be *plugged into* rather than weather drifting past. It's
 *      content-neutral on purpose; it can stand in for any underlying
 *      system the agent attaches to.
 *
 *   2. ATTENTION FOCI — a small number of slowly-orbiting "attention"
 *      points that locally densify the substrate (additive boost with
 *      gaussian falloff). Visually these read as wandering bright
 *      concentrations climbing the same glyph palette into `+ * #` —
 *      the agent's attention roaming the substrate, probing, evaluating.
 *      Each focus has its own lissajous orbit so they never sync, and a
 *      slow heartbeat in strength so each one feels independently alive.
 *      As a focus moves on, the cells it vacated decay back to substrate
 *      density at the ambient repaint rate, leaving a soft glyph wake —
 *      a visible trace of where the agent has been looking.
 *
 *   3. SYNAPSES — when two foci pass close enough, a dotted bridge of
 *      `·` glyphs stitches them together. Self-fades as the foci drift
 *      apart. Reads as the system's attentions recognising each other
 *      and briefly binding — the "ready to plug into anything,
 *      including each other" aspect of the metaphor.
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

// 2-D integer hash → [0,1). Stable, no allocations.
function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0
  h = ((h ^ (h >>> 13)) * 1274126177) | 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

// Value noise with cosine-smoothed bilinear interp.
//
// SUBSTRATE design choice: the substrate is intentionally quiet — a
// near-static sparse field, not drifting weather. Two knobs do this:
//
//   1. SUBSTRATE_DRIFT is small (0.05 vs the original 0.85), so the
//      base value at any cell barely changes second-to-second; it
//      shimmers, it doesn't flow.
//   2. SUBSTRATE_AMP caps the substrate's contribution at ~0.55 of
//      the [0,1) range, which through the `v*v` quantiser in the
//      glyph mapper translates to a maximum substrate glyph of `·`
//      / `.`. Denser glyphs (`+ * #`) only appear where a focus's
//      gaussian boost is climbing.
//
// Net effect: the substrate reads as a quiet lattice of low-density
// marks (the "system the agent is plugged into"), and the foci +
// synapses are the only visible motion (the "agentic" part). No
// horizontal weather band — that was meteorology, not computation.
const SUBSTRATE_DRIFT = 0.05
const SUBSTRATE_AMP   = 0.55

function vnoise(x: number, y: number, t: number): number {
  const sx = x * 0.085 + t * SUBSTRATE_DRIFT
  const sy = y * 0.125 - t * SUBSTRATE_DRIFT * 0.4
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
  return Math.max(0, Math.min(0.999, base * SUBSTRATE_AMP + focusBoost(x, y, t)))
}

// ── Attention foci ─────────────────────────────────────────────────
// A small constellation of wandering "attention" points. Each focus
// traces an independent lissajous orbit across the visible field and
// applies a gaussian density boost to nearby cells, so the substrate
// reads as: "something is looking around in here." Each focus also
// pulses softly (heartbeat) so it feels alive rather than mechanical.
//
// Sized to look intentional but not obvious — viewers should sense
// purposeful motion before they can count the foci.
const FOCI: ReadonlyArray<{
  ax: number; ay: number      // orbit amplitude (fraction of visible field, 0..0.5)
  wx: number; wy: number      // orbit angular velocity
  px: number; py: number      // orbit phase offset
  ph: number                  // heartbeat phase
  baseStrength: number        // peak additive boost
  sigma: number               // gaussian falloff radius (in cells)
}> = [
  { ax: 0.36, ay: 0.28, wx: 0.21, wy: 0.27, px: 0.0,  py: 1.7, ph: 0.0, baseStrength: 0.55, sigma: 11 },
  { ax: 0.30, ay: 0.34, wx: 0.17, wy: 0.23, px: 2.1,  py: 0.4, ph: 1.9, baseStrength: 0.48, sigma: 13 },
  { ax: 0.42, ay: 0.22, wx: 0.25, wy: 0.19, px: 4.3,  py: 3.0, ph: 3.4, baseStrength: 0.52, sigma: 10 },
]
const HEARTBEAT_HZ = 0.40       // ~2.5 s heartbeat per focus
const HEARTBEAT_AMP = 0.18      // ±18% strength modulation

// ── Synapses ───────────────────────────────────────────────────────
// When two foci pass close enough, a faint dotted trail is drawn
// between them. Reads as: the agentic system's attentions briefly
// recognising and binding to each other — which is also a metaphor
// for "ready to plug into anything." The trail is non-persistent;
// the ambient drift loop naturally overwrites it as foci move apart.
const SYNAPSE_MAX_DIST = 28     // cells. Engagement range.
const SYNAPSE_STEP_CELLS = 2    // glyph every N cells along the line
const SYNAPSE_MAX_ALPHA = 0.55  // multiplied by INK_OPACITY when drawn

// Field dimensions are owned by the component; foci need them to map
// normalised orbit coords to cell coords. Set on resize.
let fldCols = 0
let fldRows = 0

function focusBoost(c: number, r: number, t: number): number {
  if (fldCols === 0 || fldRows === 0) return 0
  const cx = fldCols * 0.5
  const cy = fldRows * 0.5
  let boost = 0
  for (let i = 0; i < FOCI.length; i++) {
    const f = FOCI[i]!
    const fx = cx + Math.sin(t * f.wx + f.px) * (f.ax * fldCols)
    const fy = cy + Math.sin(t * f.wy + f.py) * (f.ay * fldRows)
    const dx = c - fx
    const dy = r - fy
    const d2 = dx * dx + dy * dy
    const s2 = f.sigma * f.sigma
    if (d2 > s2 * 6) continue   // outside 2.45σ → negligible, skip
    const heartbeat = 1 + HEARTBEAT_AMP * Math.sin(t * (Math.PI * 2 * HEARTBEAT_HZ) + f.ph)
    boost += f.baseStrength * heartbeat * Math.exp(-d2 / s2)
  }
  return boost
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
      fldCols = cols
      fldRows = rows
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
            const v = vnoise(c, r, t)
            const palIdx = Math.min(PALETTE.length - 1, Math.floor(v * v * PALETTE.length))
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
        const v = vnoise(c, r, t)
        const palIdx = Math.min(PALETTE.length - 1, Math.floor(v * v * PALETTE.length))
        if (palIdx === cells[idx]) continue
        cells[idx] = palIdx
        paintCellAt(c, r, PALETTE[palIdx]!)
      }

      // Synapse pass — when two attention foci pass close to each
      // other, stitch a faint trail of `·` glyphs between them. This
      // reads as the two attentions briefly recognising and binding to
      // each other — "ready to plug into anything, including each
      // other." The trail isn't persistent; the ambient drift loop
      // above will overwrite these cells as it churns through, so the
      // synapse fades naturally as the foci drift apart.
      if (revealed) drawSynapses(t)
    }

    function drawSynapses(t: number) {
      const cx = fldCols * 0.5
      const cy = fldRows * 0.5
      // Compute focus positions once per frame.
      const fxs: number[] = []
      const fys: number[] = []
      for (let i = 0; i < FOCI.length; i++) {
        const f = FOCI[i]!
        fxs.push(cx + Math.sin(t * f.wx + f.px) * (f.ax * fldCols))
        fys.push(cy + Math.sin(t * f.wy + f.py) * (f.ay * fldRows))
      }
      for (let i = 0; i < FOCI.length; i++) {
        for (let j = i + 1; j < FOCI.length; j++) {
          const dx = fxs[j]! - fxs[i]!
          const dy = fys[j]! - fys[i]!
          const dist = Math.sqrt(dx * dx + dy * dy)
          // Engage only when reasonably close (in cell units). Both
          // foci have similar sigmas so a fixed cell threshold works.
          if (dist > SYNAPSE_MAX_DIST || dist < 4) continue
          // Proximity → alpha. Closer = brighter, but cap so it stays
          // ambient, never punchy.
          const closeness = 1 - (dist - 4) / (SYNAPSE_MAX_DIST - 4)
          const alpha = Math.min(SYNAPSE_MAX_ALPHA, closeness * SYNAPSE_MAX_ALPHA)
          // Step every few cells along the line and drop a `·` glyph.
          // Don't update `cells[]` — these are transient overdraws
          // that the ambient drift loop will replace next time it
          // touches the same cell, giving us a self-fading synapse.
          const steps = Math.max(2, Math.floor(dist / SYNAPSE_STEP_CELLS))
          ctx!.globalAlpha = alpha
          ctx!.fillStyle = ink
          for (let s = 1; s < steps; s++) {
            const u = s / steps
            const cc = Math.round(fxs[i]! + dx * u)
            const rr = Math.round(fys[i]! + dy * u)
            if (cc < 0 || cc >= fldCols || rr < 0 || rr >= fldRows) continue
            ctx!.fillText("·", cc * CHAR_W, rr * LINE_H)
          }
          ctx!.globalAlpha = 1
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
