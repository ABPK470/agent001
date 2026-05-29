/**
 * WelcomeIntro — wordmark decode → tile dissolve boot animation.
 *
 * Identical concept to packages/ui-term/src/components/WelcomeIntro.tsx.
 * Self-contained (hardcoded palette — no CSS-var dependency).
 *
 * Supports two modes:
 *   "intro" (default) — tiles cover, wordmark decodes L→R, bar fills,
 *                        tiles dissolve centre→edges, shell revealed.
 *   "outro"           — tiles snap on edges→centre, wordmark visible,
 *                        bar un-fills, letters disappear R→L, done.
 *
 * Skip: any key (Esc/Space/Enter) or click → 250ms fade.
 * Reduced motion: instant exit.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"

const COLS = 36
const ROWS = 20

const WORD = "MI:A"
const SCRAMBLE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*<>?/+="

const STREAM_REVEAL_MS     = 550
const LETTER_STEP_MS       = 110
const SCRAMBLE_DURATION_MS = 90
const SCRAMBLE_TICK_MS     = 50
const STREAM_END_MS = STREAM_REVEAL_MS + (WORD.length - 1) * LETTER_STEP_MS + SCRAMBLE_DURATION_MS

const BAR_DOTS = 28
const BAR_GEN_START_MS    = STREAM_END_MS + 50
const BAR_GEN_DURATION_MS = 200
const BAR_FILL_START      = BAR_GEN_START_MS + BAR_GEN_DURATION_MS + 220
const BAR_FILL_DURATION   = 650

const BAR_END_AT      = BAR_FILL_START + BAR_FILL_DURATION
const COMPOSE_OUT     = BAR_END_AT
const DISSOLVE_AT     = BAR_END_AT
const DISSOLVE_SPREAD = 700

// ── Outro (reverse) timeline ─────────────────────────────────────────────
const OUTRO_TILES_DONE      = 800
const OUTRO_COMP_IN_MS      = OUTRO_TILES_DONE
const OUTRO_BAR_UNFILL_AT   = OUTRO_COMP_IN_MS + 400
const OUTRO_BAR_UNFILL_DUR  = 650
const OUTRO_WORD_AT         = OUTRO_BAR_UNFILL_AT + OUTRO_BAR_UNFILL_DUR + 150
const OUTRO_WORD_END        = OUTRO_WORD_AT + (WORD.length - 1) * LETTER_STEP_MS + SCRAMBLE_DURATION_MS
const OUTRO_COMP_OUT_MS     = OUTRO_WORD_END + 100
const OUTRO_TOTAL_MS        = OUTRO_COMP_OUT_MS + 400

interface Props {
  onDone: () => void
  durationMs?: number
  mode?: "intro" | "outro"
}

function randomGlyph(seed: number): string {
  const i = Math.abs((seed * 9301 + 49297) % SCRAMBLE_ALPHABET.length)
  return SCRAMBLE_ALPHABET[i]!
}

type LetterState = "hidden" | "scrambling" | "locked"
interface LetterCell { state: LetterState; glyph: string }

export function WelcomeIntro({ onDone, durationMs = 3600, mode = "intro" }: Props) {
  const isOutro = mode === "outro"
  const [skipping, setSkipping] = useState(false)
  const [cells, setCells] = useState<LetterCell[]>(
    () => WORD.split("").map(() => ({ state: "hidden" as const, glyph: "" })),
  )
  const startedAtRef = useRef<number>(performance.now())

  const onDoneRef = useRef(onDone)
  useEffect(() => { onDoneRef.current = onDone })

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onDoneRef.current(); return
    }

    // ── Outro: reverse animation ──
    if (isOutro) {
      setCells(WORD.split("").map((ch) => ({ state: "locked" as const, glyph: ch })))
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
            const ri = WORD.length - 1 - i
            const disappearAt = OUTRO_WORD_AT + ri * LETTER_STEP_MS
            const goneAt = disappearAt + SCRAMBLE_DURATION_MS
            if (elapsed < disappearAt) continue
            if (elapsed >= goneAt) {
              if (next[i]!.state !== "hidden") next[i] = { state: "hidden", glyph: "" }
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
        window.clearTimeout(doneT); cancelAnimationFrame(raf)
        setSkipping(true); window.setTimeout(() => onDoneRef.current(), 250)
      }
      window.addEventListener("keydown", skip)
      return () => {
        window.clearTimeout(doneT); cancelAnimationFrame(raf)
        window.removeEventListener("keydown", skip)
      }
    }

    // ── Intro: forward animation ──
    const startedAt = startedAtRef.current
    const doneAt = window.setTimeout(() => onDoneRef.current(), durationMs)

    let raf = 0
    let lastTick = 0
    const tick = (now: number) => {
      const elapsed = now - startedAt
      if (elapsed > STREAM_END_MS + 600) return
      if (now - lastTick < SCRAMBLE_TICK_MS) { raf = requestAnimationFrame(tick); return }
      lastTick = now
      setCells((prev) => {
        const next = prev.slice()
        for (let i = 0; i < WORD.length; i++) {
          const revealAt = STREAM_REVEAL_MS + i * LETTER_STEP_MS
          const lockAt = revealAt + SCRAMBLE_DURATION_MS
          if (elapsed < revealAt) continue
          if (elapsed >= lockAt) {
            if (next[i]!.state !== "locked") next[i] = { state: "locked", glyph: WORD[i]! }
          } else {
            next[i] = { state: "scrambling", glyph: randomGlyph(Math.floor(now) + i * 17) }
          }
        }
        return next
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    const skip = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== " " && e.key !== "Enter") return
      window.clearTimeout(doneAt); cancelAnimationFrame(raf)
      setSkipping(true); window.setTimeout(() => onDoneRef.current(), 250)
    }
    window.addEventListener("keydown", skip)
    return () => {
      window.clearTimeout(doneAt)
      cancelAnimationFrame(raf)
      window.removeEventListener("keydown", skip)
    }
  }, [isOutro, durationMs])

  const mosaicCells = useMemo(() => {
    const total = COLS * ROWS
    const cx = (COLS - 1) / 2
    const cy = (ROWS - 1) / 2
    const maxDist = Math.hypot(cx, cy)
    return Array.from({ length: total }, (_, i) => {
      const c = i % COLS
      const r = Math.floor(i / COLS)
      const j1 = Math.abs((Math.sin(c * 12.9898 + r * 78.233) * 43758.5453) % 1)
      const dist = Math.hypot(c - cx, r - cy) / maxDist
      return { c, r, phase: j1, dist }
    })
  }, [])

  const OUTRO_SPREAD = 700
  function tileSnapDelay(dist: number, phase: number): string {
    if (isOutro) {
      return `a001i-snap-in 1ms steps(1) ${(1 - dist) * OUTRO_SPREAD + phase * 60}ms forwards`
    }
    return `a001i-snap 1ms steps(1) ${DISSOLVE_AT + dist * DISSOLVE_SPREAD + phase * 90}ms forwards`
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
      className={`a001i ${skipping ? "a001i-skip" : ""}`}
      onClick={() => { setSkipping(true); window.setTimeout(() => onDoneRef.current(), 250) }}
      role="presentation"
      aria-hidden="true"
    >
      <div className="a001i-mosaic" aria-hidden="true">
        {mosaicCells.map(({ c, r, phase, dist }, i) => (
          <span
            key={i}
            className="a001i-cell"
            style={{
              gridColumn: c + 1,
              gridRow: r + 1,
              opacity: isOutro ? 0 : 1,
              animation: tileSnapDelay(dist, phase),
            }}
          />
        ))}
      </div>

      <div
        className="a001i-comp"
        style={{
          animation: isOutro
            ? `a001i-in 500ms ease-out ${OUTRO_COMP_IN_MS}ms forwards, a001i-out 320ms ease-in ${OUTRO_COMP_OUT_MS}ms forwards`
            : `a001i-in 500ms ease-out 400ms forwards, a001i-out 320ms ease-in ${COMPOSE_OUT}ms forwards`,
        }}
      >
        <span className="a001i-word" aria-label="mia">
          {cells.map((cell, i) => (
            <span
              key={i}
              className={`a001i-letter${cell.state === "scrambling" ? " a001i-scramble" : ""}`}
            >
              {cell.state === "hidden" ? "\u00A0" : cell.glyph}
            </span>
          ))}
        </span>

        <span className="a001i-bar">
          <span className="a001i-bar-wrap">
            <span className="a001i-bar-track">
              {Array.from({ length: BAR_DOTS }).map((_, i) => (
                <span
                  key={i}
                  className="a001i-bar-cell"
                  style={isOutro
                    ? { opacity: 1 }
                    : { animation: `a001i-bci 220ms ease-out ${barTrackDelays[i]}ms forwards` }
                  }
                />
              ))}
            </span>
            <span
              className="a001i-bar-fill"
              style={isOutro
                ? { clipPath: "inset(0 0 0 0)", animation: `a001i-bunfill ${OUTRO_BAR_UNFILL_DUR}ms cubic-bezier(.65,0,.35,1) ${OUTRO_BAR_UNFILL_AT}ms forwards` }
                : { animation: `a001i-bf ${BAR_FILL_DURATION}ms cubic-bezier(.65,0,.35,1) ${BAR_FILL_START}ms forwards` }
              }
            >
              {Array.from({ length: BAR_DOTS }).map((_, i) => (
                <span key={i} className="a001i-bar-cell a001i-bar-cell-on" />
              ))}
            </span>
          </span>
        </span>
      </div>

      <span
        className="a001i-hint"
        style={isOutro
          ? { animation: `a001i-hint-in 400ms ease-out ${OUTRO_COMP_IN_MS}ms forwards, a001i-hint-out 300ms ease-in ${OUTRO_COMP_OUT_MS}ms forwards` }
          : undefined
        }
      >press any key to skip</span>

      <style>{`
        .a001i {
          position: fixed; inset: 0; z-index: 9999;
          background: transparent;
          display: flex; align-items: center; justify-content: center;
          cursor: pointer;
          font-family: var(--font-mono);
        }
        .a001i-skip { animation: a001i-skip-anim 250ms linear forwards !important; }
        @keyframes a001i-skip-anim { to { opacity: 0; } }

        .a001i-mosaic {
          position: absolute; inset: 0;
          display: grid;
          grid-template-columns: repeat(${COLS}, 1fr);
          grid-template-rows:    repeat(${ROWS}, 1fr);
          gap: 0;
          pointer-events: none;
          z-index: 1;
        }
        .a001i-cell {
          background: var(--color-canvas);
          opacity: 1;
          will-change: opacity;
        }
        @keyframes a001i-snap { to { opacity: 0; } }
        @keyframes a001i-snap-in { to { opacity: 1; } }

        .a001i-comp {
          position: absolute; left: 50%; top: 50%;
          transform: translate(-50%, -50%);
          display: flex; align-items: center;
          gap: 28px;
          opacity: 0;
          will-change: opacity;
          z-index: 2;
          font-weight: 600;
          font-size: clamp(22px, 2.8vw, 38px);
          letter-spacing: 0.06em;
          color: var(--color-text);
        }
        @keyframes a001i-in  { to { opacity: 1; } }
        @keyframes a001i-out { to { opacity: 0; } }

        .a001i-word { display: inline-flex; white-space: nowrap; }
        .a001i-letter {
          display: inline-block; width: 0.62em; text-align: center;
          color: var(--color-text);
        }
        .a001i-scramble { color: var(--color-text-faint); opacity: 0.7; }

        .a001i-bar { display: inline-flex; align-items: center; }
        .a001i-bar-wrap {
          position: relative; display: inline-block;
          width: calc(${BAR_DOTS} * 0.5em); height: 0.6em; overflow: hidden;
        }
        .a001i-bar-track, .a001i-bar-fill {
          position: absolute; inset: 0;
          display: flex; align-items: stretch; gap: 2px;
        }
        .a001i-bar-cell {
          flex: 1 1 0; height: 100%;
          background: var(--color-overlay-3);
          opacity: 0;
        }
        @keyframes a001i-bci { to { opacity: 1; } }
        .a001i-bar-cell-on { background: var(--color-accent); opacity: 1; }
        .a001i-bar-fill {
          clip-path: inset(0 100% 0 0);
          will-change: clip-path;
        }
        @keyframes a001i-bf { to { clip-path: inset(0 0 0 0); } }
        @keyframes a001i-bunfill { to { clip-path: inset(0 100% 0 0); } }

        .a001i-hint {
          position: absolute; bottom: 28px; left: 50%;
          transform: translateX(-50%);
          color: var(--color-text-faint); font-size: 11px;
          letter-spacing: 0.18em; text-transform: uppercase;
          opacity: 0; z-index: 2;
          animation: a001i-hint-in 800ms ease-out 2400ms forwards,
                     a001i-hint-out 500ms ease-in  ${COMPOSE_OUT}ms forwards;
        }
        @keyframes a001i-hint-in  { to { opacity: 0.5; } }
        @keyframes a001i-hint-out { to { opacity: 0; } }

        @media (prefers-reduced-motion: reduce) {
          .a001i, .a001i-comp, .a001i-bar-fill,
          .a001i-cell, .a001i-letter, .a001i-hint {
            animation: none !important; opacity: 0 !important;
          }
        }
      `}</style>
    </div>,
    document.body,
  )
}
