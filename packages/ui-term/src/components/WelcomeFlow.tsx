/**
 * WelcomeFlow — login + intro/outro animation.
 *
 * INPUT FLOW (v19):
 *   Step 1: username
 *   Step 2: password (bullet-masked)
 *   Submit → caller does login-or-register; on success the morph plays.
 *
 * The visual story (bot, mosaic, wave canvas, wordmark) is unchanged —
 * only the form's two prompts moved from "name + access code" to
 * "username + password". `onSubmit(username, password)` keeps the same
 * (a, b) shape so call sites only need to relabel their args.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"

/* ── Visual constants (theme-aware via CSS vars) ────────────────────── */
const BG   = "var(--bg, #09090b)"
const FG   = "var(--text, #e4e4e7)"
const DIM  = "var(--text-faint, #52525b)"
const ACC  = "var(--accent, #d8b4fe)"
const ERR  = "var(--error, #f87171)"
const FONT = '"JetBrains Mono","SFMono-Regular",Consolas,Menlo,monospace'
const FS   = 16

/* ── Mosaic grid ───────────────────────────────────────────────────────── */
const COLS = 60
const ROWS = 34

/* ── Wordmark ──────────────────────────────────────────────────────────── */
const WORD     = "MI:A"
// const WORD     = "MI:A"
const ALPHA    = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*<>?/+="
const TICK_MS  = 50
const LOCK_MS  = 90
const SLOT_EM  = 0.62

/* ── Intro timeline ───────────────────────────────────────────────────── */
const BOT_START    = 100
const STEP_MS      = 140
const BOT_END      = BOT_START + WORD.length * STEP_MS + LOCK_MS
const DISSOLVE_AT  = BOT_END + 500
const DISSOLVE_MS  = 700

/* ── Outro timeline ───────────────────────────────────────────────────── */
const OUTRO_COVER_MS  = 800
const OUTRO_SHOW_MS   = OUTRO_COVER_MS
const OUTRO_EAT_START = OUTRO_SHOW_MS + 400
const OUTRO_EAT_END   = OUTRO_EAT_START + WORD.length * STEP_MS + LOCK_MS
const OUTRO_HIDE_MS   = OUTRO_EAT_END + 200
const OUTRO_DONE_MS   = OUTRO_HIDE_MS + 300

/* ── Helpers ───────────────────────────────────────────────────────────── */
function rndGlyph(seed: number) {
  return ALPHA[Math.abs((seed * 9301 + 49297) % ALPHA.length)]!
}

type CellState = "hidden" | "scrambling" | "locked"
interface Cell { state: CellState; glyph: string }
const hiddenCells = (): Cell[] => WORD.split("").map(() => ({ state: "hidden", glyph: "" }))
const lockedCells = (): Cell[] => WORD.split("").map(ch => ({ state: "locked", glyph: ch }))

/* ── Bot SVG ───────────────────────────────────────────────────────────── */
function Bot({ size = 42 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 14"
      shapeRendering="crispEdges" width={size} height={size * 0.7}
      style={{ display: "block", flexShrink: 0 }}>
      <rect x="0" y="3" width="3" height="8" fill="#7b6fc7b8" />
      <rect x="17" y="3" width="3" height="8" fill="#7b6fc7b8" />
      <path fill="#7B6FC7" fillRule="evenodd"
        d="M3 0 H17 V14 H3 Z M3 5 H7 V9 H3 Z M13 5 H17 V9 H13 Z" />
      <rect className="wf-eye" x="3" y="5" width="4" height="4" fill="#34d399" />
      <rect className="wf-eye" x="13" y="5" width="4" height="4" fill="#34d399" />
    </svg>
  )
}

/* ── Wave + particle canvas (ported from os2-landing index4) ──────────── */
function WaveCanvas({ visible }: { visible: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current!
    const ctx = canvas.getContext("2d")!    // Read theme once per mount so wave/particle/flash colors stay
    // legible on both the dark canvas (#09090b) and the warm light
    // canvas (#efeae0). On light we use a soft warm-grey ink instead
    // of white, which would otherwise be invisible.
    const isLight = document.documentElement.getAttribute("data-theme") === "light"
    const WAVE_STROKE = isLight ? "rgba(60,50,30,0.18)" : "rgba(255,255,255,0.18)"
    const PARTICLE_COLORS = isLight
      ? ["80,70,50", "110,95,70", "140,125,95", "93,79,176"]
      : ["255,255,255", "190,190,190", "150,150,150", "210,190,255"]
    const FLASH_RGB = isLight ? "93,79,176" : "216,180,254"
    const TOTAL = 300
    const FLOW  = 0.05  // screen-widths per second

    const px     = new Float32Array(TOTAL)
    const py     = new Float32Array(TOTAL)
    const prnd   = new Float32Array(TOTAL)
    const pspd   = new Float32Array(TOTAL)
    const pstage = new Uint8Array(TOTAL)
    const ppin   = new Uint8Array(TOTAL)
    const ppinT  = new Float32Array(TOTAL)

    function waveX(stage: number, ny: number, t: number): number {
      const ph1 = t * 0.052, ph2 = t * 0.039 + 1.83, ph3 = t * 0.061 + 3.72
      // bases: -0.68, -0.38, -0.10 — amplitude max 0.07 each → guaranteed non-crossing (gap 0.23)
      let nx: number
      if      (stage === 0) nx = -0.68 + 0.06 * Math.sin(2.0 * ny + ph1) + 0.04 * Math.sin(4.7 * ny + ph1 * 2.1)
      else if (stage === 1) nx = -0.38 + 0.05 * Math.sin(5.3 * ny + ph2) + 0.03 * Math.sin(2.9 * ny + ph2 * 0.7)
      else                  nx = -0.10 + 0.06 * Math.sin(3.4 * ny + ph3) + 0.04 * Math.sin(6.1 * ny + ph3 * 1.3)
      return (nx + 1) / 2
    }

    for (let i = 0; i < TOTAL; i++) {
      prnd[i]   = Math.random()
      pspd[i]   = 0.7 + prnd[i] * 0.5
      const s   = Math.floor(Math.random() * 3)
      pstage[i] = s
      const gx  = waveX(s, Math.random() * 2 - 1, 0)
      px[i]     = gx - prnd[i] * 0.5
      py[i]     = Math.random()
    }

    const TOTAL_FLASH = 60
    const fx     = new Float32Array(TOTAL_FLASH)
    const fy     = new Float32Array(TOTAL_FLASH)
    const fbirth = new Float32Array(TOTAL_FLASH).fill(-99)
    let fHead    = 0
    const COLORS = PARTICLE_COLORS

    let last = 0
    let raf: number

    function loop(now: number) {
      raf = requestAnimationFrame(loop)
      const t  = now / 1000
      const dt = Math.min(t - last, 0.05)
      last = t

      const W = canvas.offsetWidth
      const H = canvas.offsetHeight
      if (!W || !H) return
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H }

      ctx.clearRect(0, 0, W, H)

      // 3 wave curves
      for (let s = 0; s < 3; s++) {
        ctx.beginPath()
        for (let j = 0; j <= 100; j++) {
          const ny = (j / 100) * 2 - 1
          const x  = waveX(s, ny, t) * W
          const y  = (j / 100) * H
          j === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
        }
        ctx.strokeStyle = WAVE_STROKE
        ctx.lineWidth   = 0.8
        ctx.stroke()
      }

      // particles
      for (let i = 0; i < TOTAL; i++) {
        const ny    = py[i] * 2 - 1
        const stage = pstage[i]
        const gx    = stage < 3 ? waveX(stage, ny, t) : 2

        if (ppin[i]) {
          px[i] = gx - 0.004 - prnd[i] * 0.008
          // wave 0 holds 12s+, wave 1 holds 6s+, wave 2 releases quickly
          const delay = stage === 0 ? 12.0 + prnd[i] * 8.0
                      : stage === 1 ?  6.0 + prnd[i] * 5.0
                      :                0.6 + prnd[i] * 0.8
          if (t - ppinT[i] > delay) {
            fx[fHead] = px[i] * W; fy[fHead] = py[i] * H; fbirth[fHead] = t
            fHead = (fHead + 1) % TOTAL_FLASH
            ppin[i]   = 0
            pstage[i] = Math.min(stage + 1, 3)
            px[i]     = gx + 0.005
          }
        } else {
          px[i] += FLOW * pspd[i] * dt
          if (px[i] >= 1) {
            px[i] = -prnd[i] * 0.6; pstage[i] = 0
          } else if (stage < 3 && px[i] >= gx) {
            ppin[i] = 1; ppinT[i] = t
            px[i]   = gx - 0.004 - prnd[i] * 0.008
          }
        }

        const sx = px[i] * W, sy = py[i] * H
        if (sx < -4 || sx > W + 4) continue
        ctx.beginPath()
        ctx.arc(sx, sy, 1.5, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${COLORS[Math.min(pstage[i], 3)]},0.85)`
        ctx.fill()
      }

      // flashes
      for (let i = 0; i < TOTAL_FLASH; i++) {
        const age = t - fbirth[i]
        if (fbirth[i] < 0 || age < 0 || age > 0.55) continue
        const life = 1 - age / 0.55
        ctx.beginPath()
        ctx.arc(fx[i], fy[i], life * 3, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${FLASH_RGB},${life * life * 0.35})`
        ctx.fill()
      }
    }

    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <canvas ref={ref} style={{
      position: "absolute", inset: 0, width: "100%", height: "100%",
      opacity: visible ? 1 : 0,
      transition: "opacity 800ms ease",
      pointerEvents: "none",
    }} />
  )
}

/* ═══════════════════════════════════════════════════════════════════════ */

export interface WelcomeFlowProps {
  onSubmit: (username: string, password: string) => Promise<void>
  onDone: () => void
  mode?: "intro" | "outro" | "reveal"
}

type Step = "login" | "submitting" | "morphing" | "dissolving" | "done"

export function WelcomeFlow({ onSubmit, onDone, mode = "intro" }: WelcomeFlowProps) {
  const isOutro = mode === "outro"
  const isReveal = mode === "reveal"

  const [step, setStep] = useState<Step>(isOutro || isReveal ? "dissolving" : "login")
  const [draft, setDraft] = useState("")
  const [nameVal, setNameVal] = useState("")
  const [nameStep, setNameStep] = useState(true)   // true = username, false = password
  const [err, setErr] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [cells, setCells] = useState<Cell[]>(hiddenCells)
  const [glowReady, setGlowReady] = useState(false)
  const [cursorOn, setCursorOn] = useState(true)
  // tracks the real selectionStart/End of the hidden input so the block cursor
  // follows actual caret position (arrow keys, Ctrl+A, word jumps, etc.)
  const [cursorPos, setCursorPos] = useState(0)
  const [selEnd,    setSelEnd]    = useState(0)
  // Must defer one rAF: browser updates selectionStart AFTER the event fires,
  // so reading it synchronously in onChange/onKeyDown always gives stale position.
  const syncCursor = useCallback(() => {
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      setCursorPos(el.selectionStart ?? 0)
      setSelEnd(el.selectionEnd   ?? 0)
    })
  }, [])

  // Typing activity — reset blink idle timer on every keystroke
  const blinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const blinkIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const resetBlinkIdle = useCallback(() => {
    // Immediately show cursor solid
    setCursorOn(true)
    if (blinkIntervalRef.current) { clearInterval(blinkIntervalRef.current); blinkIntervalRef.current = null }
    if (blinkTimerRef.current) clearTimeout(blinkTimerRef.current)
    // Resume blinking after 1s of inactivity
    blinkTimerRef.current = setTimeout(() => {
      blinkIntervalRef.current = setInterval(() => setCursorOn(v => !v), 530)
    }, 1000)
  }, [])

  /* cursor blink — starts after 1s of inactivity */
  useEffect(() => {
    resetBlinkIdle()
    return () => {
      if (blinkTimerRef.current) clearTimeout(blinkTimerRef.current)
      if (blinkIntervalRef.current) clearInterval(blinkIntervalRef.current)
    }
  }, [resetBlinkIdle])

  /* let glow fade in after first paint */
  useEffect(() => {
    const af = requestAnimationFrame(() => setGlowReady(true))
    return () => cancelAnimationFrame(af)
  }, [])

  /* stable onDone ref */
  const onDoneRef = useRef(onDone)
  useEffect(() => { onDoneRef.current = onDone })
  const doneRef = useRef(false)
  const fireDone = useCallback(() => {
    if (doneRef.current) return
    doneRef.current = true
    onDoneRef.current()
  }, [])

  const reduced = useMemo(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches, [],
  )

  /* ── autofocus ── */
  useEffect(() => {
    if (step === "login") setTimeout(() => inputRef.current?.focus(), 800)
  }, [step, nameStep])

  /* ── INTRO morphing: bot L→R, letters trail ── */
  useEffect(() => {
    if (step !== "morphing" || isOutro) return
    if (reduced) { fireDone(); return }
    const t0 = performance.now()
    let raf = 0, last = 0
    const tick = (now: number) => {
      const dt = now - t0
      if (now - last >= TICK_MS) {
        last = now
        setCells(prev => {
          const n = prev.slice()
          for (let i = 0; i < WORD.length; i++) {
            const reveal = BOT_START + i * STEP_MS
            const lock = reveal + LOCK_MS
            if (dt < reveal) continue
            if (dt >= lock) {
              if (n[i]!.state !== "locked") n[i] = { state: "locked", glyph: WORD[i]! }
            } else {
              n[i] = { state: "scrambling", glyph: rndGlyph(Math.floor(now) + i * 17) }
            }
          }
          return n
        })
      }
      if (dt < BOT_END + 200) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    const t = setTimeout(() => setStep("dissolving"), DISSOLVE_AT)
    return () => { cancelAnimationFrame(raf); clearTimeout(t) }
  }, [step, isOutro, reduced, fireDone])

  /* ── INTRO dissolve: tiles fade outward → done ── */
  useEffect(() => {
    if (step !== "dissolving" || isOutro) return
    // Wait for the outermost tiles to finish fading (max delay + fade duration)
    const maxDelay = 600 + 40 + 80   // dist*600 + phase*40 + 80ms animation
    const t = setTimeout(() => fireDone(), maxDelay + 200)
    return () => clearTimeout(t)
  }, [step, isOutro, fireDone])

  /* ── OUTRO: tiles cover inward → done ── */
  useEffect(() => {
    if (step !== "dissolving" || !isOutro) return
    if (reduced) { fireDone(); return }
    // Wait for innermost tiles to finish appearing
    const maxDelay = 600 + 40 + 80   // (1-dist)*600 + phase*40 + 80ms animation
    const t = setTimeout(() => fireDone(), maxDelay + 100)
    return () => clearTimeout(t)
  }, [step, isOutro, reduced, fireDone])

  /* ── skip on any key / click ── */
  useEffect(() => {
    if (step !== "morphing" && step !== "dissolving") return
    const h = () => fireDone()
    window.addEventListener("keydown", h)
    return () => window.removeEventListener("keydown", h)
  }, [step, fireDone])

  /* ── form submit ── */
  const onEnter = useCallback(() => {
    const v = draft.trim()
    setErr(null)
    if (nameStep) {
      if (!v) { setErr("username required"); return }
      setNameVal(v); setDraft(""); setNameStep(false)
    } else {
      if (!v) { setErr("password required"); return }
      setDraft("")
      const uname = nameVal
      setStep("submitting")
      onSubmit(uname, v)
        .then(() => setStep("morphing"))
        .catch(e => {
          setErr(e instanceof Error ? e.message : String(e))
          setStep("login"); setNameStep(false)
        })
    }
  }, [draft, nameStep, nameVal, onSubmit])

  /* ── go back from password → username ──
   * Two affordances, both terminal-native:
   *   • Backspace on an empty password input — the natural "erase past
   *     the start of the line" gesture maps cleanly to "erase the line
   *     itself, back up a step".
   *   • Escape — the universal "abandon current prompt" key.
   * The previously-typed username is restored as the draft so the user
   * can edit a typo instead of retyping. */
  const onBackToUsername = useCallback(() => {
    if (step !== "login" || nameStep) return
    setNameStep(true); setDraft(nameVal); setNameVal(""); setErr(null)
    // place caret at end of restored username on next paint
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (el) { el.setSelectionRange(el.value.length, el.value.length); syncCursor() }
    })
  }, [nameStep, nameVal, step, syncCursor])

  /* ── mosaic cells ── */
  const mosaic = useMemo(() => {
    const cx = (COLS - 1) / 2, cy = (ROWS - 1) / 2
    const mx = Math.max(cx, cy)
    return Array.from({ length: COLS * ROWS }, (_, i) => {
      const c = i % COLS, r = Math.floor(i / COLS)
      const phase = Math.abs((Math.sin(c * 12.9898 + r * 78.233) * 43758.5453) % 1)
      // Chebyshev distance (square wavefront) + noise to break regularity
      const cheb = Math.max(Math.abs(c - cx), Math.abs(r - cy)) / mx
      const noise = ((Math.sin(c * 7.31 + r * 13.97) * 9991.7) % 1 + 1) % 1
      const dist = cheb * 0.8 + noise * 0.2
      return { c, r, phase, dist }
    })
  }, [])

  function tileAnim(dist: number, phase: number) {
    if (isOutro) return `wf-tile-on 80ms linear ${(1 - dist) * 600 + phase * 40}ms forwards`
    const delay = dist * 600 + phase * 40
    return `wf-tile-fade 80ms linear ${delay}ms forwards`
  }

  /* ── render flags ── */
  const isLogin   = !isOutro && (step === "login" || step === "submitting")
  const isMorph   = step === "morphing"
  const outroVis  = isOutro && step === "dissolving"
  const showComp  = isLogin || isMorph
  const showTiles = step !== "done"

  if (step === "done") return null

  return createPortal(
    <div className="wf"
      onClick={() => { if (isMorph || step === "dissolving" || outroVis) fireDone() }}>

      {/* Mosaic */}
      {showTiles && (
        <div className="wf-mosaic">
          {mosaic.map(({ c, r, phase, dist }, i) => (
            <span key={i} className="wf-tile" style={{
              gridColumn: c + 1, gridRow: r + 1,
              ...(step === "dissolving"
                ? { opacity: isOutro ? 0 : 1, animation: tileAnim(dist, phase) }
                : {}),
            }} />
          ))}
        </div>
      )}

      {/* Content */}
      <div className="wf-center">
        {/* Depth glow — fades with step */}
        <WaveCanvas visible={!!(glowReady && (step === "login" || step === "submitting" || step === "morphing") && !isOutro)} />
        <div className="wf-inner">

          {/* Bot + wordmark — THE SAME element during login AND animation */}
          {showComp && (
            <div className="wf-comp" style={
              step === "login" || step === "submitting"
                ? { opacity: 0, animation: "wf-in 400ms ease-out 300ms forwards" }
                : undefined
            }>
              <span className="wf-word">
                {cells.map((c, i) => (
                  <span key={i} className={
                    `wf-ch${c.state === "hidden" ? " wf-ch-h" : ""}${c.state === "scrambling" ? " wf-scr" : ""}`
                  }>{c.state === "hidden" ? "" : c.glyph}</span>
                ))}
              </span>
              <span className="wf-bot"><Bot /></span>
            </div>
          )}

          {/* Form inputs — sit directly below the bot */}
          {isLogin && (
            <div className="wf-form" style={{
              opacity: 0,
              animation: step === "submitting" ? undefined : "wf-in 400ms ease-out 700ms forwards",
              ...(step === "submitting" ? { opacity: 0.5 } : {}),
            }}>
              <input ref={inputRef} autoFocus value={draft}
                placeholder=""
                onChange={e => { setDraft(e.target.value); if (err) setErr(null); syncCursor(); resetBlinkIdle() }}
                onKeyDown={e => {
                  if (e.key === "Enter")  { e.preventDefault(); onEnter(); return }
                  if (e.key === "Escape" && !nameStep) { e.preventDefault(); onBackToUsername(); return }
                  if (e.key === "Backspace" && !nameStep && draft.length === 0) {
                    e.preventDefault(); onBackToUsername(); return
                  }
                  syncCursor(); resetBlinkIdle()
                }}
                onSelect={syncCursor}
                onFocus={syncCursor}
                onMouseUp={syncCursor}
                disabled={step === "submitting"}
                spellCheck={false} autoComplete="off" className="wf-inp-hidden" />
              <div className="wf-display" onClick={() => { inputRef.current?.focus(); syncCursor() }}>
                {draft ? (
                  <>
                    {/* text before cursor */}
                    {cursorPos > 0 && (
                      <span className="wf-typed">{nameStep ? draft.slice(0, cursorPos) : "•".repeat(cursorPos)}</span>
                    )}
                    {/* block cursor at real position */}
                    <span className="wf-block-cursor" style={{ visibility: cursorOn ? "visible" : "hidden" }} />
                    {/* selected region */}
                    {selEnd > cursorPos && (
                      <span className="wf-typed wf-sel">{nameStep ? draft.slice(cursorPos, selEnd) : "•".repeat(selEnd - cursorPos)}</span>
                    )}
                    {/* text after selection */}
                    {draft.length > selEnd && (
                      <span className="wf-typed">{nameStep ? draft.slice(selEnd) : "•".repeat(draft.length - selEnd)}</span>
                    )}
                  </>
                ) : (
                  <>
                    <span className="wf-block-cursor" style={{ visibility: cursorOn ? "visible" : "hidden" }} />
                    <span className="wf-placeholder">
                      {nameStep ? "username" : step === "submitting" ? "signing in…" : "password"}
                    </span>
                  </>
                )}
              </div>
              <div style={{ marginTop: 10, fontSize: 11, minHeight: "1.2em", color: DIM }}>
                {err
                  ? <span style={{ color: ERR }}>! {err}</span>
                  : !nameStep && step === "login"
                    ? <span>← <span style={{ opacity: 0.75 }}>backspace</span> to edit username</span>
                    : null}
              </div>
            </div>
          )}
        </div>
      </div>

      <style>{`
        .wf {
          position: fixed; inset: 0; z-index: 9999;
          background: transparent; font-family: ${FONT}; color: ${FG};
          display: flex; align-items: center; justify-content: center;
          cursor: default;
        }

        .wf-center {
          position: relative; z-index: 4;
          display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          width: 100%; height: 100%;
        }

        /* Column container — everything centered, nudged right so
           the bot feels like the destination the particles flow toward */
        .wf-inner {
          position: relative;
          width: 340px; max-width: 90vw;
          display: flex; flex-direction: column;
          align-items: center;
          transform: translateX(min(24vw, 350px));
        }

        /* Bot + wordmark row — centered */
        .wf-comp {
          display: inline-flex; align-items: center;
          gap: 18px;
        }

        .wf-word {
          display: inline-flex; white-space: nowrap;
          font-weight: 600; font-size: clamp(22px, 2.8vw, 38px);
        }
        .wf-ch {
          display: inline-block; width: ${SLOT_EM}em;
          text-align: center; color: ${FG}; overflow: hidden;
          transition: width 100ms ease, color 80ms linear, opacity 80ms linear;
        }
        .wf-ch-h { width: 0; }
        .wf-scr { color: ${DIM}; opacity: 0.7; }

        .wf-bot { flex-shrink: 0; }

        /* Form — positioned below comp, doesn't affect comp's position */
        .wf-form {
          position: absolute; top: 100%; left: 50%;
          transform: translateX(-50%);
          width: 220px; padding-top: 24px;
          transition: opacity 200ms ease;
        }
        .wf-inp-hidden {
          position: absolute; opacity: 0; pointer-events: none;
          width: 0; height: 0; overflow: hidden;
        }
        .wf-display {
          display: flex; align-items: center;
          font-family: ${FONT}; font-size: 15px;
          font-weight: 400; letter-spacing: 0.02em;
          color: ${FG}; cursor: text;
          min-height: 1.4em; padding: 8px 0;
        }
        .wf-placeholder { color: ${FG}; opacity: 0.35; margin-left: 8px; white-space: nowrap; display: inline-flex; align-items: center; }
        .wf-typed { white-space: pre; }
        .wf-sel { background: var(--accent-soft, rgba(216,180,254,0.22)); border-radius: 1px; }
        .wf-block-cursor {
          display: inline-block; width: 8px; height: 1.1em;
          background: ${ACC}; margin-left: 1px;
          vertical-align: text-bottom;
        }

        /* Mosaic — sits ABOVE content so tiles act as the "wall" */
        .wf-mosaic {
          position: absolute; inset: 0; z-index: 3;
          display: grid;
          grid-template-columns: repeat(${COLS}, 1fr);
          grid-template-rows: repeat(${ROWS}, 1fr);
          gap: 0; pointer-events: none;
        }
        .wf-tile { background: ${BG}; }
        @keyframes wf-tile-fade { to { opacity: 0 } }
        @keyframes wf-tile-on  { to { opacity: 1 } }

        @keyframes wf-in  { to { opacity: 1 } }
        @keyframes wf-out { to { opacity: 0 } }

        .wf-hint {
          position: absolute; bottom: 28px; left: 50%; transform: translateX(-50%);
          color: ${DIM}; font-size: 11px;
          letter-spacing: 0.18em; text-transform: uppercase;
          opacity: 0; animation: wf-in 600ms ease-out 800ms forwards;
        }

        .wf-eye { transform-box: fill-box; transform-origin: center; animation: wf-blink 2.5s ease-in-out infinite; }
        .wf-eye:nth-child(4) { animation-delay: 0.05s; }
        @keyframes wf-blink {
          0%,85%,100% { transform: scaleY(1) }
          90% { transform: scaleY(0.08) }
          95% { transform: scaleY(1) }
        }

        @media (prefers-reduced-motion: reduce) {
          .wf, .wf * { animation: none !important; transition: none !important; }
          .wf-comp, .wf-hint { opacity: 1 !important; }
        }
      `}</style>
    </div>,
    document.body,
  )
}
