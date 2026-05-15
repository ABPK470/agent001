/**
 * WelcomeIntro — agent001 boot animation, in the term-UI palette.
 *
 * Concept (rewritten):
 *   The overlay starts as a solid `--bg` covering the live shell. The
 *   wordmark `agent001` decodes left-to-right (per-letter scramble →
 *   lock) in a single colour. A thin progress bar materialises and
 *   fills with lavender. As soon as it tops out, the cover IS the
 *   mosaic — it's secretly a grid of `--bg` tiles — and each tile
 *   snaps to invisible (no fade, hard cut) on a delay schedule from
 *   centre OUTWARD, literally uncovering the live shell underneath
 *   piece by piece. The wordmark + bar disappear with their tiles.
 *
 *   No hardcoded colors. No flash. No pulse. No idle motion.
 *   No fading: tiles snap. The shell is genuinely uncovered.
 *
 * Timeline (~3.5s):
 *   0.00s  solid black cover, wordmark area empty
 *   0.55s  letter stream begins — ~110ms / letter
 *   1.45s  word "agent001" locked (single colour, no accent)
 *   1.65s  bar track materialises (200ms)
 *   2.07s  bar fill sweeps left → right (650ms)
 *   2.72s  bar full — tiles begin snapping off, centre first
 *   2.72s  outward wave, ~700ms across all tiles, ~80ms per tile snap
 *   ~3.5s  last edge tile snaps; shell fully uncovered; unmount
 *
 * Skip: any key (Esc/Space/Enter) or click → 250ms fade.
 * Reduced motion: instant exit.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"

interface Props {
  onDone: () => void
  durationMs?: number
  mode?: "intro" | "outro"
}

// Pixel mosaic resolution. Higher = finer texture, more DOM nodes.
const COLS = 36
const ROWS = 20

// ── Streamed wordmark configuration ──────────────────────────────────────
const WORD = "agentMyMI"
// const WORD = "agent001"
const SCRAMBLE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*<>?/+="

const STREAM_REVEAL_MS    = 550
const LETTER_STEP_MS      = 110
const SCRAMBLE_DURATION_MS= 90
const SCRAMBLE_TICK_MS    = 50
const STREAM_END_MS = STREAM_REVEAL_MS + (WORD.length - 1) * LETTER_STEP_MS + SCRAMBLE_DURATION_MS

const BAR_DOTS = 28
// Bar appears shortly after wordmark locks.
const BAR_GEN_START_MS    = STREAM_END_MS + 50            // ~1450ms
const BAR_GEN_DURATION_MS = 200
// Small wait between track materialising and fill beginning — lets the
// eye register the empty track before it starts filling.
const BAR_FILL_START      = BAR_GEN_START_MS + BAR_GEN_DURATION_MS + 220   // ~2070ms
const BAR_FILL_DURATION   = 650

// As soon as the bar tops out, each tile of the cover snaps to invisible
// (hard cut, no fade) on a centre-OUTWARD delay schedule. The shell
// underneath is literally uncovered piece by piece.
const BAR_END_AT      = BAR_FILL_START + BAR_FILL_DURATION   // ~2720ms
const COMPOSE_OUT     = BAR_END_AT                           // wordmark+bar exit with their tiles
const DISSOLVE_AT     = BAR_END_AT                           // tile snapping begins now
const DISSOLVE_SPREAD = 700                                  // window over which the wave travels
const REVEAL_END      = DISSOLVE_AT + DISSOLVE_SPREAD + 100  // ~3520ms

// ── Outro (reverse) timeline ─────────────────────────────────────────────
const OUTRO_TILES_DONE      = 800                                             // tiles finish covering
const OUTRO_COMP_IN_MS      = OUTRO_TILES_DONE                                // wordmark + bar fade in
const OUTRO_BAR_UNFILL_AT   = OUTRO_COMP_IN_MS + 400                          // bar starts emptying
const OUTRO_BAR_UNFILL_DUR  = 650                                             // bar emptying duration
const OUTRO_WORD_AT         = OUTRO_BAR_UNFILL_AT + OUTRO_BAR_UNFILL_DUR + 150 // letters start disappearing
const OUTRO_WORD_END        = OUTRO_WORD_AT + (WORD.length - 1) * LETTER_STEP_MS + SCRAMBLE_DURATION_MS
const OUTRO_COMP_OUT_MS     = OUTRO_WORD_END + 100                            // wordmark fades out
const OUTRO_TOTAL_MS        = OUTRO_COMP_OUT_MS + 400                         // done

function randomGlyph(seed: number): string {
  const i = Math.abs((seed * 9301 + 49297) % SCRAMBLE_ALPHABET.length)
  return SCRAMBLE_ALPHABET[i]
}

type LetterState = "hidden" | "scrambling" | "locked"
interface LetterCell { state: LetterState; glyph: string }

export function WelcomeIntro({ onDone, durationMs = 3600, mode = "intro" }: Props) {
  const isOutro = mode === "outro"
  const [skipping, setSkipping] = useState(false)
  const [cells, setCells] = useState<LetterCell[]>(
    () => WORD.split("").map(() => ({ state: "hidden", glyph: "" })),
  )
  const [justLocked, setJustLocked] = useState<boolean[]>(
    () => WORD.split("").map(() => false),
  )
  const startedAtRef = useRef<number>(performance.now())

  // Keep a ref to onDone so the timer effect never needs onDone in its deps.
  // Without this, every App re-render (SSE events etc.) creates a new onDone
  // reference → effect cleanup clears the setTimeout → timer restarts → never fires.
  const onDoneRef = useRef(onDone)
  useEffect(() => { onDoneRef.current = onDone })

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onDoneRef.current(); return
    }
    // Outro: reverse animation — tiles cover, bar unfills, letters disappear R→L.
    if (isOutro) {
      setCells(WORD.split("").map((ch) => ({ state: "locked", glyph: ch })))
      const startedAt = performance.now()
      let raf = 0
      let lastTick = 0
      const tick = (now: number) => {
        const elapsed = now - startedAt
        if (elapsed > OUTRO_TOTAL_MS) return
        if (now - lastTick < SCRAMBLE_TICK_MS) { raf = requestAnimationFrame(tick); return }
        lastTick = now
        setCells((prev) => {
          const next = prev.slice()
          for (let i = WORD.length - 1; i >= 0; i--) {
            const ri = WORD.length - 1 - i          // right-to-left index
            const disappearAt = OUTRO_WORD_AT + ri * LETTER_STEP_MS
            const goneAt = disappearAt + SCRAMBLE_DURATION_MS
            if (elapsed < disappearAt) continue     // still locked
            if (elapsed >= goneAt) {
              if (next[i].state !== "hidden") next[i] = { state: "hidden", glyph: "" }
            } else {
              next[i] = { state: "scrambling", glyph: randomGlyph(Math.floor(now) + i * 17) }
            }
          }
          return next
        })
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)

      const doneT = window.setTimeout(() => onDoneRef.current(), OUTRO_TOTAL_MS)
      const skip = (e: KeyboardEvent) => {
        if (e.key !== "Escape" && e.key !== " " && e.key !== "Enter") return
        window.clearTimeout(doneT)
        cancelAnimationFrame(raf)
        setSkipping(true)
        window.setTimeout(() => onDoneRef.current(), 250)
      }
      window.addEventListener("keydown", skip)
      return () => {
        window.clearTimeout(doneT)
        cancelAnimationFrame(raf)
        window.removeEventListener("keydown", skip)
      }
    }
    const startedAt = startedAtRef.current
    const doneAt = window.setTimeout(() => onDoneRef.current(), durationMs)

    let raf = 0
    let lastTick = 0
    const flashed = new Set<number>()
    const tick = (now: number) => {
      const elapsed = now - startedAt
      if (elapsed > STREAM_END_MS + 600) return
      if (now - lastTick < SCRAMBLE_TICK_MS) {
        raf = requestAnimationFrame(tick); return
      }
      lastTick = now
      const newlyLocked: number[] = []
      setCells((prev) => {
        const next = prev.slice()
        for (let i = 0; i < WORD.length; i++) {
          const revealAt = STREAM_REVEAL_MS + i * LETTER_STEP_MS
          const lockAt = revealAt + SCRAMBLE_DURATION_MS
          if (elapsed < revealAt) continue
          if (elapsed >= lockAt) {
            if (next[i].state !== "locked") {
              next[i] = { state: "locked", glyph: WORD[i] }
              if (!flashed.has(i)) { flashed.add(i); newlyLocked.push(i) }
            }
          } else {
            next[i] = { state: "scrambling", glyph: randomGlyph(Math.floor(now) + i * 17) }
          }
        }
        return next
      })
      if (newlyLocked.length > 0) {
        setJustLocked((prev) => {
          const next = prev.slice()
          for (const i of newlyLocked) next[i] = true
          return next
        })
        window.setTimeout(() => {
          setJustLocked((prev) => {
            const next = prev.slice()
            for (const i of newlyLocked) next[i] = false
            return next
          })
        }, 280)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    const skip = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== " " && e.key !== "Enter") return
      window.clearTimeout(doneAt)
      cancelAnimationFrame(raf)
      setSkipping(true)
      window.setTimeout(() => onDoneRef.current(), 250)
    }
    window.addEventListener("keydown", skip)
    return () => {
      window.clearTimeout(doneAt)
      cancelAnimationFrame(raf)
      window.removeEventListener("keydown", skip)
    }
  }, [isOutro, durationMs])

  // Pre-compute mosaic cells with deterministic pseudo-random properties:
  // each cell gets a phase offset for the breathing animation, a
  // distance-from-centre value for the outward dissolve, and a one-bit
  // "is-accent" flag (~12% of tiles) so a few sparkle in lavender.
  const mosaicCells = useMemo(() => {
    const total = COLS * ROWS
    const cx = (COLS - 1) / 2
    const cy = (ROWS - 1) / 2
    const maxDist = Math.hypot(cx, cy)
    const arr: { c: number; r: number; phase: number; dist: number; accent: boolean }[] = new Array(total)
    for (let i = 0; i < total; i++) {
      const c = i % COLS
      const r = Math.floor(i / COLS)
      const j1 = Math.abs((Math.sin(c * 12.9898 + r * 78.233) * 43758.5453) % 1)
      const j2 = Math.abs((Math.sin(c * 39.346 + r * 11.135) * 21731.95) % 1)
      const dist = Math.hypot(c - cx, r - cy) / maxDist            // 0..1
      arr[i] = { c, r, phase: j1, dist, accent: j2 < 0.12 }
    }
    return arr
  }, [])

  // Outro tile snap: edges first (dist=1 → delay=0), center last (dist=0 → delay=max).
  // Intro tile snap: center first (dist=0 → delay=0), edges last.
  const OUTRO_SPREAD = 700  // edges→center over 700ms, clearly distinct from intro's dissolve
  function tileSnapDelay(dist: number, phase: number): string {
    if (isOutro) {
      // reversed: edges (dist~1) snap first
      return `a001-cell-snap-in 1ms steps(1) ${(1 - dist) * OUTRO_SPREAD + phase * 60}ms forwards`
    }
    return `a001-cell-snap 1ms steps(1) ${DISSOLVE_AT + dist * DISSOLVE_SPREAD + phase * 90}ms forwards`
  }

  const barTrackDelays = useMemo(
    () => Array.from({ length: BAR_DOTS }, (_, i) => {
      const j = Math.abs((Math.sin(i * 91.31 + 13.7) * 9999) % 1)
      return BAR_GEN_START_MS + j * BAR_GEN_DURATION_MS
    }),
    [],
  )

  return createPortal(
    <div
      className={`a001-intro ${skipping ? "a001-intro-skip" : ""}`}
      onClick={() => { setSkipping(true); window.setTimeout(() => onDoneRef.current(), 250) }}
      role="presentation"
      aria-hidden="true"
    >
      {/* ── Mosaic field ──────────────────────────────────────
          Dim cells over the dark canvas. Most idle in zinc, a few in
          lavender. They breathe in/out continuously, then a "settled"
          pulse brightens everything once, then they dissolve outward
          from the centre to expose the live shell underneath. */}
      {/* ── Mosaic cover ─────────────────────────────
          A grid of solid --bg tiles that together form a seamless cover
          over the live shell. When the dissolve phase begins, each tile
          snaps to invisible (hard cut, no fade) on a centre-outward
          delay schedule — literally uncovering the page beneath. */}
      <div className="a001-mosaic" aria-hidden="true">
        {mosaicCells.map(({ c, r, phase, dist }, i) => {
          return (
            <span
              key={i}
              className="a001-mosaic-cell"
              style={{
                gridColumn: c + 1,
                gridRow: r + 1,
                opacity: isOutro ? 0 : 1,
                animation: tileSnapDelay(dist, phase),
              }}
            />
          )
        })}
      </div>

      {/* Wordmark + bar — shown in both intro and outro with different timings */}
      <div
        className="a001-term"
        style={{
          animation: isOutro
            ? `a001-term-in 500ms ease-out ${OUTRO_COMP_IN_MS}ms forwards, a001-term-out 320ms ease-in ${OUTRO_COMP_OUT_MS}ms forwards`
            : `a001-term-in  500ms ease-out 400ms forwards, a001-term-out 320ms ease-in ${COMPOSE_OUT}ms forwards`,
        }}
      >
        <span className="a001-word" aria-label="mia">
          {cells.map((cell, i) => (
            <span
              key={i}
              className={[
                "a001-letter",
                cell.state === "scrambling" ? "a001-letter-scramble" : "",
                cell.state === "locked" ? "a001-letter-locked" : "",
              ].join(" ")}
            >
              {cell.state === "hidden" ? "\u00A0" : cell.glyph}
            </span>
          ))}
        </span>
        <span className="a001-term-bar" aria-hidden="true">
          <span className="a001-term-bar-cells">
            <span className="a001-term-bar-track">
              {Array.from({ length: BAR_DOTS }).map((_, i) => (
                <span
                  key={i}
                  className="a001-term-bar-cell"
                  style={isOutro
                    ? { opacity: 1 }
                    : { animation: `a001-bar-cell-in 220ms ease-out ${barTrackDelays[i]}ms forwards` }
                  }
                />
              ))}
            </span>
            <span
              className="a001-term-bar-fill"
              style={isOutro
                ? { clipPath: "inset(0 0 0 0)", animation: `a001-bar-unfill ${OUTRO_BAR_UNFILL_DUR}ms cubic-bezier(.65,.0,.35,1) ${OUTRO_BAR_UNFILL_AT}ms forwards` }
                : { animation: `a001-bar-fill ${BAR_FILL_DURATION}ms cubic-bezier(.65,.0,.35,1) ${BAR_FILL_START}ms forwards` }
              }
            >
              {Array.from({ length: BAR_DOTS }).map((_, i) => (
                <span key={i} className="a001-term-bar-cell a001-term-bar-cell-on" />
              ))}
            </span>
          </span>
        </span>
      </div>

      <span
        className="a001-hint"
        style={isOutro
          ? { animation: `a001-hint-in 400ms ease-out ${OUTRO_COMP_IN_MS}ms forwards, a001-hint-out 300ms ease-in ${OUTRO_COMP_OUT_MS}ms forwards` }
          : undefined
        }
      >press any key to skip</span>
      <style>{`
        .a001-intro {
          position: fixed; inset: 0; z-index: 9999;
          /* No background here — the mosaic tiles ARE the cover. The
             container stays transparent so as tiles snap off, the
             live shell behind is genuinely uncovered. */
          background: transparent;
          display: flex; align-items: center; justify-content: center;
          cursor: pointer;
          opacity: 1;
          font-family: var(--font-mono);
        }
        .a001-intro-skip { animation: a001-intro-skip 250ms linear forwards !important; }
        @keyframes a001-intro-skip { to { opacity: 0; } }

        /* ── Pixel mosaic cover ─────────────────────────────────── */
        .a001-mosaic {
          position: absolute; inset: 0;
          display: grid;
          grid-template-columns: repeat(${COLS}, 1fr);
          grid-template-rows:    repeat(${ROWS}, 1fr);
          /* Zero gap so the tiles form a seamless cover — no visible
             grid lines until they begin snapping off. */
          gap: 0;
          pointer-events: none;
          z-index: 1;
        }
        .a001-mosaic-cell {
          background: var(--bg);
          opacity: 1;
          will-change: opacity;
        }
        /* Hard cut — no fade. Each tile literally disappears, uncovering
           a piece of the live shell behind. */
        @keyframes a001-cell-snap {
          to { opacity: 0; }
        }
        /* Outro: tile snaps visible (covering the shell again). */
        @keyframes a001-cell-snap-in {
          to { opacity: 1; }
        }

        /* ── Composition (wordmark + bar) ─────────────────────── */
        .a001-term {
          position: absolute;
          left: 50%; top: 50%;
          transform: translate(-50%, -50%);
          display: flex; align-items: center;
          gap: 28px;
          opacity: 0;
          will-change: opacity;
          z-index: 2;
          font-weight: 600;
          font-size: clamp(22px, 2.8vw, 38px);
          letter-spacing: 0.06em;
          color: var(--fg);
        }
        @keyframes a001-term-in  { to { opacity: 1; } }
        @keyframes a001-term-out { to { opacity: 0; } }

        /* ── Streamed wordmark ────────────────────────────────── */
        .a001-word {
          display: inline-flex;
          white-space: nowrap;
        }
        .a001-letter {
          display: inline-block;
          width: 0.62em;
          text-align: center;
          color: var(--fg);
          transition: color 80ms linear;
        }
        .a001-letter-scramble {
          color: var(--fg-mute);
          opacity: 0.7;
        }
        .a001-letter-locked {
          color: var(--fg);
        }
        /* No accent, no flash, no glow on lock — single colour throughout. */

        /* ── Progress bar ─────────────────────────────────────── */
        .a001-term-bar {
          display: inline-flex;
          align-items: center;
        }
        .a001-term-bar-cells {
          position: relative;
          display: inline-block;
          width: calc(${BAR_DOTS} * 0.5em);
          height: 0.6em;
          overflow: hidden;
        }
        .a001-term-bar-track,
        .a001-term-bar-fill {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: stretch;
          gap: 2px;
        }
        .a001-term-bar-cell {
          flex: 1 1 0;
          height: 100%;
          background: var(--bg-soft);
          opacity: 0;
        }
        @keyframes a001-bar-cell-in { to { opacity: 1; } }
        .a001-term-bar-cell-on {
          background: var(--accent-dim);
          opacity: 1;
        }
        .a001-term-bar-fill {
          clip-path: inset(0 100% 0 0);
          will-change: clip-path;
        }
        @keyframes a001-bar-fill { to { clip-path: inset(0 0 0 0); } }
        @keyframes a001-bar-unfill { to { clip-path: inset(0 100% 0 0); } }

        /* ── Skip hint ────────────────────────────────────────── */
        .a001-hint {
          position: absolute;
          bottom: 28px; left: 50%;
          transform: translateX(-50%);
          color: var(--fg-mute);
          font-size: var(--fs-xs);
          letter-spacing: 0.18em;
          text-transform: uppercase;
          opacity: 0;
          z-index: 2;
          animation: a001-hint-in 800ms ease-out 2400ms forwards,
                     a001-hint-out 500ms ease-in ${COMPOSE_OUT}ms forwards;
        }
        @keyframes a001-hint-in  { to { opacity: 0.5; } }
        @keyframes a001-hint-out { to { opacity: 0; } }

        @media (prefers-reduced-motion: reduce) {
          .a001-intro, .a001-term, .a001-term-bar-fill,
          .a001-mosaic-cell, .a001-letter, .a001-hint {
            animation: none !important; opacity: 0 !important;
          }
        }
      `}</style>
    </div>,
    document.body,
  )
}
