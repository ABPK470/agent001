/**
 * WelcomeFlow — unified login → intro → shell transition.
 *
 * One continuous experience on the same full-screen page:
 *
 *   1. "landing"     — page fades in (200ms), logo + blinking eyes centred
 *   2. "name"        — name input appears below logo
 *   3. "upn"         — access code input
 *   4. "submitting"  — saving…
 *   5. "morphing"    — form fades out, logo slides to left-centre,
 *                      "agent001" streams in letter-by-letter to the right
 *                      of the logo (as if the bot types it), progress bar
 *                      appears and fills
 *   6. "dissolving"  — mosaic tiles snap off centre→outward, uncovering
 *                      the live shell underneath
 *
 * The whole flow feels like one page — no jarring cuts, no separate screens.
 *
 * Also supports `mode="outro"` for logout: tiles cover → wordmark + bar
 * reverse → done callback.
 *
 * Shared between ui-term and ui (classic). Classic re-exports this.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"

// ── Visual constants ─────────────────────────────────────────────────────
const BG     = "var(--bg, #09090b)"
const FG     = "#e4e4e7"
const DIM    = "#52525b"
const ACCENT = "#d8b4fe"
const ERR    = "#f87171"
const FONT   = '"JetBrains Mono","SFMono-Regular",Consolas,Menlo,monospace'
const FS     = 16

// ── Mosaic ───────────────────────────────────────────────────────────────
const COLS = 36
const ROWS = 20

// ── Wordmark streaming ───────────────────────────────────────────────────
const WORD = "MI:A"
// const WORD = "agent001"
const SCRAMBLE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*<>?/+="
const LETTER_STEP_MS       = 110
const SCRAMBLE_DURATION_MS = 90
const SCRAMBLE_TICK_MS     = 50

// Morph-phase timeline (relative to morph start):
const MORPH_FORM_FADE_MS   = 300    // form fades out
const WORD_STREAM_START    = MORPH_FORM_FADE_MS + 200  // wordmark starts after form fades
const WORD_STREAM_END      = WORD_STREAM_START + (WORD.length - 1) * LETTER_STEP_MS + SCRAMBLE_DURATION_MS

// Progress bar
const BAR_DOTS = 28
const BAR_START            = WORD_STREAM_END + 100
const BAR_FILL_DURATION    = 650
const BAR_END              = BAR_START + BAR_FILL_DURATION

// Tile dissolve (centre → outward)
const DISSOLVE_AT          = BAR_END
const DISSOLVE_SPREAD      = 700

// ── Outro (reverse) timeline ─────────────────────────────────────────────
const OUTRO_TILES_DONE     = 800
const OUTRO_COMP_IN_MS     = OUTRO_TILES_DONE
const OUTRO_BAR_UNFILL_AT  = OUTRO_COMP_IN_MS + 400
const OUTRO_BAR_UNFILL_DUR = 650
const OUTRO_WORD_AT        = OUTRO_BAR_UNFILL_AT + OUTRO_BAR_UNFILL_DUR + 150
const OUTRO_WORD_END       = OUTRO_WORD_AT + (WORD.length - 1) * LETTER_STEP_MS + SCRAMBLE_DURATION_MS
const OUTRO_COMP_OUT_MS    = OUTRO_WORD_END + 100
const OUTRO_TOTAL_MS       = OUTRO_COMP_OUT_MS + 400

// ── Helpers ──────────────────────────────────────────────────────────────
function randomGlyph(seed: number): string {
  const i = Math.abs((seed * 9301 + 49297) % SCRAMBLE_ALPHABET.length)
  return SCRAMBLE_ALPHABET[i]!
}

function genSuffix(): string {
  const arr = new Uint8Array(2)
  crypto.getRandomValues(arr)
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("")
}
const SESSION_SUFFIX = genSuffix()

type LetterState = "hidden" | "scrambling" | "locked"
interface LetterCell { state: LetterState; glyph: string }

// ── Logo SVG ─────────────────────────────────────────────────────────────
function BotLogo({ size = 40 }: { size?: number }) {
  const h = size * 0.7
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 14"
      shapeRendering="crispEdges"
      width={size}
      height={h}
      style={{ display: "block", flexShrink: 0 }}
    >
      <rect x="0" y="3" width="3" height="8" fill="#7b6fc7b8" />
      <rect x="17" y="3" width="3" height="8" fill="#7b6fc7b8" />
      <path
        fill="#7B6FC7"
        fillRule="evenodd"
        d="M3 0 H17 V14 H3 Z M3 5 H7 V9 H3 Z M13 5 H17 V9 H13 Z"
      />
      <rect className="a001f-eye" x="3" y="5" width="4" height="4" fill="#34d399" />
      <rect className="a001f-eye" x="13" y="5" width="4" height="4" fill="#34d399" />
    </svg>
  )
}

// ── Component ────────────────────────────────────────────────────────────

export interface WelcomeFlowProps {
  /** Called after identity is submitted. */
  onSubmit: (displayName: string, upn: string) => Promise<void>
  /** Called when the entire flow (login + animation) is done → shell. */
  onDone: () => void
  /** "intro" = login → animation → shell. "outro" = tiles cover → reverse anim → done. */
  mode?: "intro" | "outro"
}

type Step = "landing" | "name" | "upn" | "submitting" | "morphing" | "dissolving"

export function WelcomeFlow({ onSubmit, onDone, mode = "intro" }: WelcomeFlowProps) {
  const isOutro = mode === "outro"
  const [step, setStep] = useState<Step>(isOutro ? "dissolving" : "landing")
  const [draft, setDraft] = useState("")
  const [nameVal, setNameVal] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const [skipping, setSkipping] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Wordmark letter state
  const [cells, setCells] = useState<LetterCell[]>(
    () => WORD.split("").map(() => ({ state: "hidden" as const, glyph: "" })),
  )

  // Stable ref for onDone to avoid timer restarts on parent re-renders
  const onDoneRef = useRef(onDone)
  useEffect(() => { onDoneRef.current = onDone })

  // Guard: onDone must fire at most once per lifecycle
  const doneCalledRef = useRef(false)
  const fireDone = useCallback(() => {
    if (doneCalledRef.current) return
    doneCalledRef.current = true
    onDoneRef.current()
  }, [])

  const reducedMotion = useMemo(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  )

  // ── Landing fade-in → show name input ──
  useEffect(() => {
    if (step !== "landing") return
    if (reducedMotion) { setStep("name"); return }
    const t = window.setTimeout(() => setStep("name"), 300)
    return () => window.clearTimeout(t)
  }, [step, reducedMotion])

  // ── Autofocus input on step change ──
  useEffect(() => {
    if (step === "name" || step === "upn") {
      window.setTimeout(() => inputRef.current?.focus(), 30)
    }
  }, [step])

  // ── Morphing phase: stream wordmark letters ──
  useEffect(() => {
    if (step !== "morphing") return
    if (reducedMotion) { fireDone(); return }
    const startedAt = performance.now()
    let raf = 0
    let lastTick = 0
    const tick = (now: number) => {
      const elapsed = now - startedAt
      if (elapsed > WORD_STREAM_END + 200) return
      if (now - lastTick < SCRAMBLE_TICK_MS) { raf = requestAnimationFrame(tick); return }
      lastTick = now
      setCells(prev => {
        const next = prev.slice()
        for (let i = 0; i < WORD.length; i++) {
          const revealAt = WORD_STREAM_START + i * LETTER_STEP_MS
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

    // After wordmark + bar done → switch to dissolving
    const dissolveT = window.setTimeout(() => setStep("dissolving"), DISSOLVE_AT)

    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(dissolveT)
    }
  }, [step, reducedMotion, fireDone])

  // ── Dissolving phase: wait for tiles to finish, then call onDone ──
  useEffect(() => {
    if (step !== "dissolving") return
    if (isOutro) {
      // Outro: reverse animation
      setCells(WORD.split("").map(ch => ({ state: "locked" as const, glyph: ch })))
      const startedAt = performance.now()
      let raf = 0
      let lastTick = 0
      const tick = (now: number) => {
        const elapsed = now - startedAt
        if (elapsed > OUTRO_TOTAL_MS) return
        if (now - lastTick < SCRAMBLE_TICK_MS) { raf = requestAnimationFrame(tick); return }
        lastTick = now
        setCells(prev => {
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
      const doneT = window.setTimeout(() => fireDone(), OUTRO_TOTAL_MS)
      return () => { cancelAnimationFrame(raf); window.clearTimeout(doneT) }
    }

    // Intro dissolve: tiles snap outward, then done
    const doneT = window.setTimeout(() => fireDone(), DISSOLVE_SPREAD + 200)
    return () => window.clearTimeout(doneT)
  }, [step, isOutro, fireDone])

  // ── Skip on key press (Esc/Space/Enter during morphing/dissolving) ──
  useEffect(() => {
    if (step !== "morphing" && step !== "dissolving") return
    let skipT: number | null = null
    const skip = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== " " && e.key !== "Enter") return
      setSkipping(true)
      skipT = window.setTimeout(() => fireDone(), 250)
    }
    window.addEventListener("keydown", skip)
    return () => {
      window.removeEventListener("keydown", skip)
      if (skipT !== null) window.clearTimeout(skipT)
    }
  }, [step, fireDone])

  // ── Reduced motion ──
  // For outro: skip animation entirely → fire done immediately.
  // For intro: animations are skipped inside their respective effects,
  //            but the login form must still be shown (don't call onDone).
  useEffect(() => {
    if (!reducedMotion) return
    if (isOutro) fireDone()
  }, [reducedMotion, isOutro, fireDone])

  // ── Form handlers ──
  const onEnter = useCallback(() => {
    const v = draft.trim()
    setErr(null)
    if (step === "name") {
      if (!v) { setErr("name required"); return }
      setNameVal(v)
      setDraft("")
      setStep("upn")
    } else if (step === "upn") {
      setDraft("")
      const uniqueName = `${nameVal} #${SESSION_SUFFIX}`
      setStep("submitting")
      onSubmit(uniqueName, v).then(() => {
        setStep("morphing")
      }).catch(e => {
        setErr(e instanceof Error ? e.message : String(e))
        setStep("upn")
      })
    }
  }, [step, draft, nameVal, onSubmit])

  // ── Mosaic cells (pre-computed) ──
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

  const OUTRO_TILE_SPREAD = 700
  function tileDelay(dist: number, phase: number): string {
    if (isOutro) {
      return `a001f-tile-on 1ms steps(1) ${(1 - dist) * OUTRO_TILE_SPREAD + phase * 60}ms forwards`
    }
    // Intro dissolve — tiles snap off centre-outward
    return `a001f-tile-off 1ms steps(1) ${dist * DISSOLVE_SPREAD + phase * 90}ms forwards`
  }

  // ── Determine visual state ──
  const showForm = step === "name" || step === "upn" || step === "submitting"
  const showMorph = step === "morphing" || step === "dissolving"
  const showTiles = step === "dissolving"
  const showOutro = isOutro

  // Form position: centred column. During morph: logo slides to left of wordmark.
  // We achieve the morph by having two layouts — form layout and morph layout —
  // and crossfading between them.

  return createPortal(
    <div
      className={`a001f ${skipping ? "a001f-skip" : ""}`}
      style={{ opacity: step === "landing" ? 0 : 1 }}
      onClick={() => {
        if (showMorph) {
          setSkipping(true)
          window.setTimeout(() => fireDone(), 250)
        }
      }}
    >
      {/* ── Mosaic tile layer ── */}
      {(showTiles || showOutro) && (
        <div className="a001f-mosaic">
          {mosaicCells.map(({ c, r, phase, dist }, i) => (
            <span
              key={i}
              className="a001f-tile"
              style={{
                gridColumn: c + 1,
                gridRow: r + 1,
                opacity: isOutro ? 0 : 1,
                animation: tileDelay(dist, phase),
              }}
            />
          ))}
        </div>
      )}

      {/* ── Content layer ── */}
      <div className="a001f-content">

        {/* LOGIN FORM — visible during name/upn/submitting steps */}
        {showForm && (
          <div className="a001f-form" style={{ opacity: step === "submitting" ? 0.5 : 1 }}>
            <BotLogo size={40} />
            <div style={{ marginTop: 40, width: 400, maxWidth: "90vw" }}>
              {/* Locked name shown during upn step */}
              {(step === "upn" || step === "submitting") && (
                <div style={{ fontSize: FS, color: FG, opacity: 0.35, marginBottom: 10 }}>
                  {nameVal}
                </div>
              )}
              <input
                ref={inputRef}
                autoFocus
                value={draft}
                placeholder={
                  step === "name"       ? "name"        :
                  step === "submitting" ? "saving…"     :
                                          "access code"
                }
                onChange={e => { setDraft(e.target.value); if (err) setErr(null) }}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); onEnter() } }}
                disabled={step === "submitting"}
                spellCheck={false}
                autoComplete="off"
                className="a001f-input"
              />
              <div style={{ marginTop: 12, fontSize: 11, minHeight: "1.2em", color: DIM }}>
                {err
                  ? <span style={{ color: ERR }}>! {err}</span>
                  : step === "upn" ? "leave blank to skip" : null
                }
              </div>
            </div>
          </div>
        )}

        {/* MORPH / INTRO COMPOSITION — logo + wordmark + bar */}
        {(showMorph || showOutro) && (
          <div
            className="a001f-comp"
            style={{
              animation: showOutro
                ? `a001f-fade-in 500ms ease-out ${OUTRO_COMP_IN_MS}ms forwards, a001f-fade-out 320ms ease-in ${OUTRO_COMP_OUT_MS}ms forwards`
                : "a001f-fade-in 400ms ease-out forwards",
            }}
          >
            <BotLogo size={48} />
            <span className="a001f-word">
              {cells.map((cell, i) => (
                <span
                  key={i}
                  className={`a001f-letter${cell.state === "scrambling" ? " a001f-scramble" : ""}`}
                >
                  {cell.state === "hidden" ? "\u00A0" : cell.glyph}
                </span>
              ))}
            </span>
            <span className="a001f-bar">
              <span className="a001f-bar-wrap">
                <span
                  className="a001f-bar-fill"
                  style={showOutro
                    ? { clipPath: "inset(0 0 0 0)", animation: `a001f-bar-unfill ${OUTRO_BAR_UNFILL_DUR}ms cubic-bezier(.65,0,.35,1) ${OUTRO_BAR_UNFILL_AT}ms forwards` }
                    : { animation: `a001f-bar-fill ${BAR_FILL_DURATION}ms cubic-bezier(.65,0,.35,1) ${BAR_START}ms forwards` }
                  }
                >
                  {Array.from({ length: BAR_DOTS }).map((_, i) => (
                    <span key={i} className="a001f-bar-dot" />
                  ))}
                </span>
              </span>
            </span>
          </div>
        )}

        {/* Skip hint */}
        {(showMorph || showOutro) && (
          <span className="a001f-hint">press any key to skip</span>
        )}
      </div>

      <style>{`
        /* ── Container ────────────────────────────────────── */
        .a001f {
          position: fixed; inset: 0; z-index: 9999;
          background: ${BG};
          font-family: ${FONT};
          color: ${FG};
          display: flex; align-items: center; justify-content: center;
          transition: opacity 300ms ease;
          cursor: default;
        }
        .a001f-skip { animation: a001f-skip-anim 250ms linear forwards !important; }
        @keyframes a001f-skip-anim { to { opacity: 0; pointer-events: none; } }

        /* ── Content layer ────────────────────────────────── */
        .a001f-content {
          position: relative; z-index: 2;
          display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          width: 100%; height: 100%;
        }

        /* ── Login form ───────────────────────────────────── */
        .a001f-form {
          display: flex; flex-direction: column;
          align-items: center;
          transition: opacity 300ms ease;
          animation: a001f-fade-in 300ms ease-out forwards;
        }
        .a001f-input {
          display: block; width: 100%;
          background: transparent; border: 0;
          border-bottom: 1px solid ${DIM};
          outline: none; color: ${FG};
          font-family: ${FONT}; font-size: ${FS}px;
          padding: 6px 0; caret-color: ${ACCENT};
          box-sizing: border-box;
        }
        .a001f-input::placeholder { color: ${DIM}; opacity: 1; }
        .a001f-input:focus {
          border-bottom-color: ${ACCENT} !important;
          transition: border-bottom-color 120ms ease;
        }

        /* ── Morph composition (logo + wordmark + bar) ──── */
        .a001f-comp {
          display: flex; align-items: center;
          gap: 20px;
          opacity: 0;
        }
        @keyframes a001f-fade-in  { to { opacity: 1; } }
        @keyframes a001f-fade-out { to { opacity: 0; } }

        /* ── Wordmark ─────────────────────────────────────── */
        .a001f-word {
          display: inline-flex; white-space: nowrap;
          font-weight: 600;
          font-size: clamp(22px, 2.8vw, 38px);
          letter-spacing: 0.06em;
        }
        .a001f-letter {
          display: inline-block; width: 0.62em;
          text-align: center; color: ${FG};
          transition: color 80ms linear;
        }
        .a001f-scramble { color: ${DIM}; opacity: 0.7; }

        /* ── Progress bar ─────────────────────────────────── */
        .a001f-bar {
          display: inline-flex; align-items: center;
          margin-left: 8px;
        }
        .a001f-bar-wrap {
          position: relative; display: inline-block;
          width: calc(${BAR_DOTS} * 0.5em); height: 0.6em;
          overflow: hidden; border-radius: 2px;
          background: ${DIM}33;
        }
        .a001f-bar-fill {
          position: absolute; inset: 0;
          display: flex; align-items: stretch; gap: 2px;
          clip-path: inset(0 100% 0 0);
          will-change: clip-path;
        }
        @keyframes a001f-bar-fill   { to { clip-path: inset(0 0 0 0); } }
        @keyframes a001f-bar-unfill { to { clip-path: inset(0 100% 0 0); } }
        .a001f-bar-dot {
          flex: 1 1 0; height: 100%;
          background: ${ACCENT}99;
        }

        /* ── Mosaic tiles ─────────────────────────────────── */
        .a001f-mosaic {
          position: absolute; inset: 0; z-index: 3;
          display: grid;
          grid-template-columns: repeat(${COLS}, 1fr);
          grid-template-rows:    repeat(${ROWS}, 1fr);
          gap: 0; pointer-events: none;
        }
        .a001f-tile {
          background: ${BG};
          will-change: opacity;
        }
        @keyframes a001f-tile-off { to { opacity: 0; } }
        @keyframes a001f-tile-on  { to { opacity: 1; } }

        /* ── Hint ─────────────────────────────────────────── */
        .a001f-hint {
          position: absolute; bottom: 28px; left: 50%;
          transform: translateX(-50%);
          color: ${DIM}; font-size: 11px;
          letter-spacing: 0.18em; text-transform: uppercase;
          opacity: 0; z-index: 2;
          animation: a001f-fade-in 600ms ease-out 800ms forwards;
        }

        /* ── Eye blink ────────────────────────────────────── */
        .a001f-eye {
          transform-box: fill-box;
          transform-origin: center;
          animation: a001f-blink 2s ease-in-out infinite;
        }
        .a001f-eye:nth-child(4) { animation-delay: 0.05s; }
        @keyframes a001f-blink {
          0%, 80%, 100% { transform: scaleY(1); }
          87%            { transform: scaleY(0.08); }
          93%            { transform: scaleY(1); }
        }

        @media (prefers-reduced-motion: reduce) {
          .a001f, .a001f * {
            animation: none !important;
            transition: none !important;
          }
          .a001f-comp, .a001f-hint {
            opacity: 1 !important;
          }
        }
      `}</style>
    </div>,
    document.body,
  )
}
