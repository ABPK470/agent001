/**
 * WelcomeFlow — unified login → intro → shell transition.
 *
 * One continuous experience on the same full-screen page:
 *
 *   1. "landing"     — dark bg appears instantly, content fades in
 *   2. "name"        — name input appears below logo
 *   3. "upn"         — access code input
 *   4. "submitting"  — saving…
 *   5. "morphing"    — form fades out, bot starts on the left and
 *                      slides right — letters appear BEHIND it as a
 *                      trail:  🤖 → [a][g][e][n][t][0][0][1] 🤖
 *                      The bot IS the progress indicator.
 *   6. "dissolving"  — mosaic tiles snap off centre→outward, uncovering
 *                      the live shell underneath
 *
 * Also supports `mode="outro"` for logout: tiles cover → bot slides L←R
 * eating the wordmark → done callback.
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

// ── Wordmark ─────────────────────────────────────────────────────────────
const WORD = "agentMyMI"
const SCRAMBLE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*<>?/+="
const SCRAMBLE_TICK_MS     = 50
const SCRAMBLE_DURATION_MS = 90

// ── Morph timeline (bot slides L→R trailing wordmark) ────────────────────
const BOT_START_MS        = 100                         // tiny pause then bot starts
const BOT_STEP_MS         = 140                         // ms per letter slot
const BOT_END_MS          = BOT_START_MS + WORD.length * BOT_STEP_MS + SCRAMBLE_DURATION_MS
const DISSOLVE_AT         = BOT_END_MS + 300            // pause, then dissolve
const DISSOLVE_SPREAD     = 700

// ── Outro timeline (bot slides R→L eating wordmark) ──────────────────────
const OUTRO_TILES_DONE    = 800
const OUTRO_COMP_IN_MS    = OUTRO_TILES_DONE
const OUTRO_BOT_START     = OUTRO_COMP_IN_MS + 400
const OUTRO_BOT_END       = OUTRO_BOT_START + WORD.length * BOT_STEP_MS + SCRAMBLE_DURATION_MS
const OUTRO_COMP_OUT_MS   = OUTRO_BOT_END + 200
const OUTRO_TOTAL_MS      = OUTRO_COMP_OUT_MS + 400

// Letter slot width (em, monospace)
const SLOT_EM = 0.62

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
  const [skipping] = useState(false)
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
    // Go straight to name input (no delay)
    setStep("name")
  }, [step])

  // ── Autofocus input on step change ──
  useEffect(() => {
    if (step === "name" || step === "upn") {
      window.setTimeout(() => inputRef.current?.focus(), 30)
    }
  }, [step])

  // ── Morphing: bot leads L→R, letters trail behind ──
  // Hidden letters have width:0 → word is narrow → bot sits at right edge.
  // As letters reveal L→R, the word grows and the bot slides right.
  // Visual:  🤖 → a🤖 → ag🤖 → … → agent001 🤖
  useEffect(() => {
    if (step !== "morphing") return
    if (reducedMotion) { fireDone(); return }
    const startedAt = performance.now()
    let raf = 0
    let lastTick = 0
    const tick = (now: number) => {
      const elapsed = now - startedAt
      if (now - lastTick >= SCRAMBLE_TICK_MS) {
        lastTick = now
        setCells(prev => {
          const next = prev.slice()
          for (let i = 0; i < WORD.length; i++) {
            const revealAt = BOT_START_MS + i * BOT_STEP_MS
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
      }
      if (elapsed < BOT_END_MS + 200) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    const dissolveT = window.setTimeout(() => setStep("dissolving"), DISSOLVE_AT)
    return () => { cancelAnimationFrame(raf); window.clearTimeout(dissolveT) }
  }, [step, reducedMotion, fireDone])

  // ── Dissolving phase: tiles snap outward / outro reverse ──
  useEffect(() => {
    if (step !== "dissolving") return
    if (isOutro) {
      // Outro: all letters start visible, bot at right.
      // Letters disappear R→L, bot slides left naturally.
      setCells(WORD.split("").map(ch => ({ state: "locked" as const, glyph: ch })))
      const startedAt = performance.now()
      let raf = 0
      let lastTick = 0
      const tick = (now: number) => {
        const elapsed = now - startedAt
        if (now - lastTick >= SCRAMBLE_TICK_MS) {
          lastTick = now
          setCells(prev => {
            const next = prev.slice()
            for (let i = WORD.length - 1; i >= 0; i--) {
              const ri = WORD.length - 1 - i
              const disappearAt = OUTRO_BOT_START + ri * BOT_STEP_MS
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
        }
        if (elapsed < OUTRO_TOTAL_MS) raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
      // Hide the composition cleanly, then fire done after a beat
      const hiddenT = window.setTimeout(() => {
        setStep("landing") // hides comp + tiles → clean screen
        window.setTimeout(() => fireDone(), 200) // brief pause then callback
      }, OUTRO_COMP_OUT_MS)
      return () => { cancelAnimationFrame(raf); window.clearTimeout(hiddenT) }
    }

    // Intro dissolve: tiles snap outward, then done
    const doneT = window.setTimeout(() => fireDone(), DISSOLVE_SPREAD + 200)
    return () => window.clearTimeout(doneT)
  }, [step, isOutro, fireDone])

  // ── Skip on any key press or click ──
  useEffect(() => {
    if (step !== "morphing" && step !== "dissolving") return
    const skip = (_e: KeyboardEvent | MouseEvent) => {
      fireDone()
    }
    window.addEventListener("keydown", skip)
    return () => {
      window.removeEventListener("keydown", skip)
    }
  }, [step, fireDone])

  // ── Reduced motion ──
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
  const showForm  = !isOutro && (step === "name" || step === "upn" || step === "submitting")
  const showMorph = step === "morphing" || step === "dissolving"
  const showTiles = step === "dissolving"
  // Outro step flow: "dissolving" (tiles cover + bot eats) → "landing" (hidden, waiting for fireDone)
  const outroVisible = isOutro && step === "dissolving"
  // During intro dissolving, make the container bg transparent so tiles reveal the shell
  const bgTransparent = step === "dissolving" && !isOutro
  // Bot + wordmark composition is visible during login (just bot), morphing, dissolving, and outro
  const showComp = showForm || showMorph || outroVisible

  return createPortal(
    <div
      className={`a001f ${skipping ? "a001f-skip" : ""}`}
      style={bgTransparent ? { background: "transparent" } : undefined}
      onClick={() => {
        if (showMorph || outroVisible) {
          fireDone()
        }
      }}
    >
      {/* ── Mosaic tile layer ── */}
      {(showTiles || outroVisible) && (
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

        {/*
          BOT + WORDMARK COMPOSITION — always rendered.
          During login: all letters hidden → only bot visible, acts as the form's logo.
          During morphing: letters appear L→R behind bot → bot slides right.
          During dissolving: fades out as tiles reveal shell.
          Same element, same position, no page switch.
        */}
        {showComp && (
          <div
            className="a001f-comp"
            style={{
              ...(isOutro
                ? { opacity: 0, animation: `a001f-fade-in 400ms ease-out ${OUTRO_COMP_IN_MS}ms forwards` }
                : step === "dissolving"
                  ? { opacity: 1, animation: "a001f-fade-out 300ms ease-in forwards" }
                  : { opacity: 1 }),
            }}
          >
            <span className="a001f-word">
              {cells.map((cell, i) => (
                <span
                  key={i}
                  className={`a001f-letter${cell.state === "hidden" ? " a001f-letter-hidden" : ""}${cell.state === "scrambling" ? " a001f-scramble" : ""}`}
                >
                  {cell.state === "hidden" ? "" : cell.glyph}
                </span>
              ))}
            </span>
            <span className="a001f-bot"><BotLogo size={42} /></span>
          </div>
        )}

        {/* LOGIN FORM INPUTS — below the bot, fades out when morphing starts */}
        {showForm && (
          <div className="a001f-form">
            <div style={{ width: 400, maxWidth: "90vw" }}>
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

        {/* Skip hint */}
        {(showMorph || outroVisible) && (
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
          cursor: default;
        }
        .a001f-skip { opacity: 0; pointer-events: none; }

        /* ── Content layer ────────────────────────────────── */
        .a001f-content {
          position: relative; z-index: 4;
          display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          width: 100%; height: 100%;
        }

        /* ── Login form ───────────────────────────────────── */
        .a001f-form {
          display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          margin-top: 40px;
          transition: opacity 300ms ease;
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

        /* ── Morph composition (flex row: word + bot) ───── */
        .a001f-comp {
          display: inline-flex; align-items: center;
          gap: 10px;
        }
        @keyframes a001f-fade-in  { to { opacity: 1; } }
        @keyframes a001f-fade-out { to { opacity: 0; } }

        /* ── Wordmark ─────────────────────────────────────── */
        .a001f-word {
          display: inline-flex; white-space: nowrap;
          font-weight: 600;
          font-size: clamp(22px, 2.8vw, 38px);
        }
        .a001f-letter {
          display: inline-block;
          width: ${SLOT_EM}em;
          text-align: center;
          color: ${FG};
          overflow: hidden;
          transition: width 100ms ease, color 80ms linear, opacity 80ms linear;
        }
        .a001f-letter-hidden {
          width: 0;
        }
        .a001f-scramble { color: ${DIM}; opacity: 0.7; }

        /* ── Bot ───────────────────────────────────────────── */
        .a001f-bot {
          flex-shrink: 0;
          filter: drop-shadow(0 0 8px ${ACCENT}44);
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
