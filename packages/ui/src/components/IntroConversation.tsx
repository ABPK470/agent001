import { ExternalLink, Send, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { App } from "../App"
import { useStore } from "../store"
import { ASCII_SCRAMBLE_GLYPHS, IntroAsciiField } from "./IntroAsciiField"
import { Logo } from "./Logo"
import { introBasePath, loginOrRegister } from "./introShared"

interface Msg { role: "bot" | "user"; text: string; streamed?: boolean }

// ── MI:A wordmark decoder ─────────────────────────────────────────────
// Same scramble alphabet & timings as WelcomeIntro so the brand
// reveal feels native to the rest of the app.
const SCRAMBLE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*<>?/+="
const WORDMARK = "MI:A"
const WM_REVEAL_DELAY_MS  = 220
const WM_LETTER_STEP_MS   = 110
const WM_SCRAMBLE_DUR_MS  = 90
const WM_SCRAMBLE_TICK_MS = 50
function wmRandomGlyph(seed: number): string {
  const i = Math.abs((seed * 9301 + 49297) % SCRAMBLE_ALPHABET.length)
  return SCRAMBLE_ALPHABET[i]!
}
type WmCellState = "hidden" | "scrambling" | "locked"
interface WmCell { state: WmCellState; glyph: string }

function MiaWordmark() {
  const [cells, setCells] = useState<WmCell[]>(
    () => WORDMARK.split("").map(() => ({ state: "hidden", glyph: "" })),
  )

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setCells(WORDMARK.split("").map((ch) => ({ state: "locked", glyph: ch })))
      return
    }
    const startedAt = performance.now()
    let raf = 0
    let lastTick = 0
    const total = WM_REVEAL_DELAY_MS + WORDMARK.length * WM_LETTER_STEP_MS + WM_SCRAMBLE_DUR_MS + 100
    const tick = (now: number) => {
      const elapsed = now - startedAt
      if (elapsed > total) return
      if (now - lastTick < WM_SCRAMBLE_TICK_MS) { raf = requestAnimationFrame(tick); return }
      lastTick = now
      setCells((prev) => {
        const next = prev.slice()
        for (let i = 0; i < WORDMARK.length; i++) {
          const revealAt = WM_REVEAL_DELAY_MS + i * WM_LETTER_STEP_MS
          const lockAt = revealAt + WM_SCRAMBLE_DUR_MS
          if (elapsed < revealAt) continue
          if (elapsed >= lockAt) {
            if (next[i]!.state !== "locked") next[i] = { state: "locked", glyph: WORDMARK[i]! }
          } else {
            next[i] = { state: "scrambling", glyph: wmRandomGlyph(Math.floor(now) + i * 17) }
          }
        }
        return next
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <span className="intro3-wordmark" aria-label="MI:A">
      {cells.map((cell, i) => (
        <span
          key={i}
          className={`intro3-wm-letter${cell.state === "scrambling" ? " intro3-wm-scramble" : ""}`}
        >
          {cell.state === "hidden" ? "\u00A0" : cell.glyph}
        </span>
      ))}
    </span>
  )
}

// ── Streaming text — character-by-character LLM-style reveal. ─────────
// Each newly-revealed char briefly cycles through the ASCII field's
// glyph palette before settling, so the text reads as crystallising
// out of the background field rather than typing onto it.
const SETTLE_MS = 140
const SETTLE_TICK_MS = 40
function StreamingText({
  text,
  onDone,
  speedMs = 22,
}: { text: string; onDone?: () => void; speedMs?: number }) {
  const [n, setN] = useState(0)
  const [tick, setTick] = useState(0)
  const revealedAtRef = useRef<number[]>([])
  const onDoneRef = useRef(onDone)
  useEffect(() => { onDoneRef.current = onDone })
  useEffect(() => { setN(0); revealedAtRef.current = [] }, [text])
  useEffect(() => {
    if (n >= text.length) { onDoneRef.current?.(); return }
    const t = window.setTimeout(() => {
      revealedAtRef.current[n] = performance.now()
      setN((v) => v + 1)
    }, speedMs)
    return () => window.clearTimeout(t)
  }, [n, text, speedMs])
  // Drive the per-frame settle animation while any recently-revealed
  // char is still scrambling. Bails out as soon as all settled.
  useEffect(() => {
    const now = performance.now()
    const stillScrambling = revealedAtRef.current
      .slice(0, n)
      .some((ts) => ts && now - ts < SETTLE_MS)
    if (!stillScrambling) return
    const id = window.setInterval(() => setTick((v) => v + 1), SETTLE_TICK_MS)
    return () => window.clearInterval(id)
  }, [n, tick])
  const now = performance.now()
  return (
    <>
      {text.slice(0, n).split("").map((ch, i) => {
        const at = revealedAtRef.current[i]
        const age = at ? now - at : SETTLE_MS
        if (age < SETTLE_MS && ch !== " " && ch !== "\n") {
          const g = ASCII_SCRAMBLE_GLYPHS
          const r = (Math.random() * g.length) | 0
          return <span key={i} className="intro3-crystal-cell">{g[r]}</span>
        }
        return <span key={i}>{ch}</span>
      })}
      {n < text.length && <span className="intro3-caret" aria-hidden="true">▍</span>}
    </>
  )
}

// ── Crystal label — continuously coalescing text, used for the
//    activity labels (Loading / Thinking / Verifying). One or two
//    letters at a time momentarily flip to an ASCII glyph, so the
//    label always feels like it's forming out of the field. ────────
function CrystalText({ text }: { text: string }) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick((v) => v + 1), 110)
    return () => window.clearInterval(id)
  }, [])
  // Deterministic per-tick pick of which indices scramble; tied to
  // tick so rerenders during a single tick are stable. The rotation
  // formula must not lock any single position (in particular position
  // 0 — `tick*N % len` would always pick 0). Using `tick + i*offset`
  // guarantees every position visits the scramble set over time.
  const scrambleSet = new Set<number>()
  const slots = Math.max(1, Math.floor(text.length * 0.18))
  for (let i = 0; i < slots; i++) {
    const idx = ((tick + i * 3) % text.length + text.length) % text.length
    scrambleSet.add(idx)
  }
  return (
    <>
      {text.split("").map((ch, i) => {
        if (ch === " " || !scrambleSet.has(i)) return <span key={i}>{ch}</span>
        const g = ASCII_SCRAMBLE_GLYPHS
        const r = ((tick + i) * 9301 + 49297) % g.length
        return <span key={i} className="intro3-crystal-cell">{g[r]}</span>
      })}
    </>
  )
}

// ── Decay text — outro scramble. Letters R→L go locked → scrambling
//    → hidden (encrypted-then-gone), mirroring WelcomeIntro's outro. ──
const DECAY_LEAD_MS     = 240
const DECAY_STEP_MS     = 35
const DECAY_SCRAMBLE_MS = 110
const DECAY_TICK_MS     = 45
type DecayCellState = "locked" | "scrambling" | "hidden"
interface DecayCell { state: DecayCellState; glyph: string }

function DecayText({ text, active }: { text: string; active: boolean }) {
  const [cells, setCells] = useState<DecayCell[]>(
    () => text.split("").map((ch) => ({ state: "locked", glyph: ch })),
  )

  // Reset whenever the source text changes while not yet active.
  useEffect(() => {
    if (!active) setCells(text.split("").map((ch) => ({ state: "locked", glyph: ch })))
  }, [text, active])

  useEffect(() => {
    if (!active) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setCells(text.split("").map(() => ({ state: "hidden", glyph: "" })))
      return
    }
    // Wait for the bubble chrome (bg, border, shadow) to fade out
    // BEFORE the letters start to scramble away. Otherwise the text
    // looks like it abandons a still-visible empty bubble shell.
    const startedAt = performance.now() + DECAY_LEAD_MS
    const total = DECAY_LEAD_MS + text.length * DECAY_STEP_MS + DECAY_SCRAMBLE_MS + 100
    let raf = 0
    let lastTick = 0
    const tick = (now: number) => {
      const elapsed = now - startedAt
      if (elapsed > total) return
      if (now - lastTick < DECAY_TICK_MS) { raf = requestAnimationFrame(tick); return }
      lastTick = now
      setCells((prev) => {
        const next = prev.slice()
        // R→L: rightmost letter disappears first.
        for (let i = text.length - 1; i >= 0; i--) {
          const ri = text.length - 1 - i
          const startAt = ri * DECAY_STEP_MS
          const goneAt = startAt + DECAY_SCRAMBLE_MS
          if (elapsed < startAt) continue
          if (elapsed >= goneAt) {
            if (next[i]!.state !== "hidden") next[i] = { state: "hidden", glyph: "" }
          } else {
            next[i] = { state: "scrambling", glyph: wmRandomGlyph(Math.floor(now) + i * 17) }
          }
        }
        return next
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active, text])

  return (
    <span className="intro3-decay">
      {cells.map((cell, i) => (
        <span
          key={i}
          className={`intro3-decay-cell${cell.state === "scrambling" ? " intro3-decay-cell--scramble" : ""}${cell.state === "hidden" ? " intro3-decay-cell--hidden" : ""}`}
        >
          {cell.state === "hidden" ? "" : cell.glyph || "\u00A0"}
        </span>
      ))}
    </span>
  )
}

/**
 * /intro3 — "a conversation, not a form".
 *
 * The screen opens already mid-chat: the bot has asked "who am I
 * talking to?". You answer. Bot: "prove it." You answer. Bot:
 * "come in." — and the same chat surface morphs into the platform's
 * default term-chat widget.
 *
 * Visual seamlessness contract:
 *   - The bare login screen shows ONLY the chat surface (no platform
 *     header, no widget chrome). The widget chrome and platform
 *     header are revealed by the entry morph, not shown up-front.
 *   - The input bar sits centered & narrow during login; on entry it
 *     slides down and expands to its full TermChat-bottom-docked
 *     position.
 *   - A pixel-art logo sits in the top-left corner from page-load,
 *     with the "MI:A" wordmark rolling out beside it. The wordmark
 *     rolls back in (collapses) during the entry morph because the
 *     real platform Toolbar shows only the logo glyph.
 *   - Bubble shapes, fonts, paddings, the bg-panel widget shell, the
 *     drag-handle label and controls are 1:1 with WidgetFrame +
 *     TermChat populated state.
 */
export type IntroMorphMode = "empty" | "chat" | "nochat"
export interface IntroMorphTarget {
  left: number
  top: number
  width: number
  height: number
}

export function IntroConversation({
  onEntered,
  onEnteringStart,
  onLoginSuccess,
  onLogin,
  enterTrigger = false,
  morphMode = "chat",
  morphTarget,
}: {
  onEntered?: () => void
  onEnteringStart?: () => void
  /** Fired right after "come in." finishes streaming, BEFORE the morph
   *  begins. Parent uses this to mount the platform underneath and
   *  measure the target landing rect for the input bar. */
  onLoginSuccess?: () => void
  /** Optional override for the auth call. When unset, falls back to the
   *  default `loginOrRegister` from `introShared` (same contract). The
   *  embedded-in-App.tsx case passes its own version so the parent's
   *  refreshMe() / phase logic stay in charge. */
  onLogin?: (username: string, password: string) => Promise<void>
  /** Parent flips to true once App is painted + target measured. When
   *  this becomes true the intro triggers its entering morph. */
  enterTrigger?: boolean
  morphMode?: IntroMorphMode
  morphTarget?: IntroMorphTarget
} = {}) {
  const [step, setStep]             = useState<"username" | "password" | "done">("username")
  const [username, setUsername]     = useState("")
  const [draft, setDraft]           = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [entering, setEntering]     = useState(false)
  const [error, setError]           = useState<string | null>(null)
  const [botTyping, setBotTyping]   = useState(false)
  const [shimmerLabel, setShimmerLabel] = useState<string>("Loading")
  // The first bot message is not seeded — it's spoken (shimmer + stream)
  // only after the MI:A wordmark finishes decoding so the screen unfolds
  // in sequence: wordmark → bot greeting → input bar.
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [inputReady, setInputReady] = useState(false)
  // Resolved when the ambient ASCII field finishes rolling out from left
  // to right. We hold the opening "who am I talking to?" until then so
  // the screen reads as: wordmark → field arrives → bot greets.
  const asciiReadyRef = useRef<{ promise: Promise<void>; resolve: () => void }>()
  if (!asciiReadyRef.current) {
    let resolve: () => void = () => {}
    const promise = new Promise<void>((r) => { resolve = r })
    asciiReadyRef.current = { promise, resolve }
  }
  const inputRef  = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const t = document.title
    document.title = "MI:A"
    return () => { document.title = t }
  }, [])

  // Sequence the opening: wait for the wordmark to lock in, then have
  // the bot greet, then reveal the input bar. Keeps the entry feel
  // ordered rather than everything popping in simultaneously.
  useEffect(() => {
    let cancelled = false
    const wordmarkDoneMs =
      WM_REVEAL_DELAY_MS + WORDMARK.length * WM_LETTER_STEP_MS + WM_SCRAMBLE_DUR_MS + 200
    const run = async () => {
      await Promise.all([
        new Promise((r) => window.setTimeout(r, wordmarkDoneMs)),
        asciiReadyRef.current!.promise,
      ])
      if (cancelled) return
      await botReply("who am I talking to?", "Loading", 600)
      if (cancelled) return
      setInputReady(true)
    }
    void run()
    return () => { cancelled = true }
    // Intentionally empty deps — runs once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (entering || step === "done" || !inputReady) return
    if (submitting || botTyping) return
    const raf = window.requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
    return () => window.cancelAnimationFrame(raf)
  }, [step, entering, inputReady, submitting, botTyping, error])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs, botTyping])

  function push(role: Msg["role"], text: string) {
    setMsgs((prev) => [...prev, { role, text }])
  }

  async function botReply(text: string, shimmer: string, delay = 650): Promise<void> {
    setShimmerLabel(shimmer)
    setBotTyping(true)
    await new Promise((r) => window.setTimeout(r, delay))
    setBotTyping(false)
    // Tiny gap so the shimmer is fully gone before the streaming bubble
    // appears — avoids the visual collision the user flagged.
    await new Promise((r) => window.setTimeout(r, 120))
    push("bot", text)
    const streamDuration = Math.max(220, text.length * 22 + 80)
    await new Promise<void>((r) => window.setTimeout(r, streamDuration))
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (submitting || entering) return
    const value = draft.trim()
    if (!value) return

    if (step === "username") {
      // Mirror server-side rule from auth/users.ts so we never advance
      // to the password step with an invalid handle. The bot echoes the
      // exact same wording the server would return.
      if (!/^[a-z0-9._-]{2,64}$/.test(value)) {
        push("user", value)
        setDraft("")
        await botReply("username must be 2-64 chars, [a-z0-9._-] — try again.", "Thinking", 300)
        return
      }
      push("user", value)
      setUsername(value)
      setDraft("")
      setError(null)
      await botReply("prove it.", "Thinking")
      setStep("password")
      return
    }

    if (step === "password") {
      // Chat-philosophy escape hatch: type `back` or `/back` (any
      // casing) to rewind to the username step without ever submitting
      // the password to the server. Keeps the conversation linear
      // without needing buttons or a back arrow that would break the
      // "native chat" feel.
      const lower = value.toLowerCase()
      if (lower === "back" || lower === "/back") {
        push("user", value)
        setDraft("")
        setError(null)
        setUsername("")
        await botReply("ok — what handle?", "Thinking", 300)
        setStep("username")
        return
      }
      push("user", "•".repeat(value.length))
      setDraft("")
      setSubmitting(true)
      setError(null)
      try {
        await (onLogin ?? loginOrRegister)(username, value)
        await botReply("come in.", "Verifying", 500)
        setStep("done")
        // After "come in.": if the parent wants to drive the morph
        // (onLoginSuccess provided), hand control over so it can mount
        // <App/> underneath, measure the input-bar landing rect, then
        // flip enterTrigger=true. Otherwise fall back to self-trigger
        // (legacy full-page-reload path).
        if (onLoginSuccess) {
          onLoginSuccess()
        } else {
          window.setTimeout(() => {
            if (onEnteringStart) onEnteringStart()
            setEntering(true)
          }, 150)
          window.setTimeout(() => {
            if (onEntered) onEntered()
            else window.location.assign(introBasePath())
          }, 1700)
        }
      } catch (err) {
        setSubmitting(false)
        const msg = err instanceof Error ? err.message : "sign-in failed"
        setError(msg)
        await botReply(`${msg} — try again.`, "Thinking", 400)
      }
    }
  }

  const inputDisabled = submitting || entering || botTyping
  const canSend = draft.trim().length > 0 && !inputDisabled

  // Parent-driven morph trigger: when enterTrigger flips true we kick
  // off the entering animation and schedule the "morph done" hand-off.
  useEffect(() => {
    if (!enterTrigger || entering) return
    if (onEnteringStart) onEnteringStart()
    setEntering(true)
    const morphMs = 1550
    const t = window.setTimeout(() => onEntered?.(), morphMs)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enterTrigger])

  // Build inline style for the input bar so it lands on the platform's
  // actual TermChat input rect (pixel-perfect) for both "empty" and
  // "chat" modes. Mode "nochat" has no target — the CSS class handles
  // a fade-up dissolve instead.
  const inputPadStyle: React.CSSProperties | undefined =
    entering && (morphMode === "empty" || morphMode === "chat") && morphTarget
      ? {
          position: "fixed",
          left:   morphTarget.left,
          top:    morphTarget.top,
          width:  morphTarget.width,
          height: morphTarget.height,
          padding: 0,
          justifyContent: "flex-start",
        }
      : undefined

  return (
    <div
      className={`intro3-root intro3-mode-${morphMode}${entering ? " intro3-root--entering" : ""}`}
      aria-label="mia-entry conversation"
    >
      {/* Generative ASCII texture — ambient life behind the conversation.
          Fades out during the morph so it doesn't bleed into the platform. */}
      <IntroAsciiField onReady={() => asciiReadyRef.current?.resolve()} />

      {/* Platform-shaped header — bg fades in from transparent → bg-canvas
          during the morph. Matches Toolbar's h-14 px-3 sm:px-6. */}
      <header className="intro3-header flex items-center px-3 sm:px-6 h-14 shrink-0 select-none gap-2 sm:gap-4">
        <div className="flex items-center gap-2.5 shrink-0">
          <Logo size={30} online />
          <MiaWordmark />
        </div>
      </header>

      {/* Canvas-shaped stage — padding fades 0 → p-2 during morph. */}
      <main className="intro3-stage flex-1 min-h-0 overflow-hidden">
        {/* Widget shell — rounded-xl + bg-panel fade in during morph. */}
        <div className="intro3-widget flex flex-col h-full overflow-hidden">
          {/* Drag handle — height fades 0 → h-8 during morph. 1:1 with
              WidgetFrame's drag handle for type=term-chat. */}
          <div className="intro3-handle widget-drag-handle flex items-center justify-between px-3 shrink-0 select-none">
            <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
              Chat
            </span>
            <div className="widget-controls flex items-center gap-1">
              <button
                type="button"
                className="text-text-muted hover:text-text p-1 rounded transition-colors"
                tabIndex={-1}
                aria-hidden="true"
              >
                <ExternalLink size={18} />
              </button>
              <button
                type="button"
                className="text-text-muted hover:text-error p-1 rounded transition-colors"
                tabIndex={-1}
                aria-hidden="true"
              >
                <X size={18} />
              </button>
            </div>
          </div>

          {/* Widget content — 1:1 with TermChat surface. */}
          <div className="widget-content flex-1 overflow-hidden p-0">
            <div className="relative flex flex-col h-full bg-transparent text-text font-sans">
              {/* Scroll area — same px/py/max-width as TermChat.
                  intro3-scroll-area gets the top fade-out mask. */}
              <div
                ref={scrollRef}
                className="intro3-scroll-area flex-1 overflow-y-auto px-6 py-5 min-h-0"
              >
                <div className="intro3-scroll-inner w-[90%] max-w-[1400px] min-h-full mx-auto flex flex-col">
                  <div className="w-full max-w-[1200px] mx-auto space-y-4">
                    {msgs.map((m, i) => {
                      const isLast = i === msgs.length - 1
                      if (m.role === "user") {
                        return (
                          <div key={i} className="flex justify-end">
                            <div
                              className="intro3-bubble-user max-w-[82%] px-4 py-2.5 bg-panel-2 dark:bg-bubble-user border border-border-subtle rounded-2xl text-[15px] text-text leading-relaxed"
                              style={{ boxShadow: "var(--shadow-bubble)" }}
                            >
                              {entering
                                ? <DecayText text={m.text} active={entering} />
                                : m.text}
                            </div>
                          </div>
                        )
                      }
                      // Bot: stream the latest, lock prior ones. On the
                      // entry morph every bubble decays (encrypt-out) in
                      // sync with the chrome reveal.
                      return (
                        <div key={i} className="text-[15px] text-text leading-relaxed font-medium">
                          {entering
                            ? <DecayText text={m.text} active={entering} />
                            : isLast
                              ? <StreamingText text={m.text} />
                              : m.text}
                        </div>
                      )
                    })}
                    {/* Constant-height slot so the chat doesn't jump
                        when the shimmer fades in/out between phases. */}
                    <div className="intro3-activity-slot py-1.5 pr-2">
                      {botTyping ? (
                        <span className="activity-shimmer-tight text-[13px] leading-6 font-medium inline-block text-text-muted">
                          <CrystalText text={shimmerLabel} />
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>

              {/* Input pad — hidden until the opening bot greeting is
                  done streaming, then fades/slides in. During the entry
                  morph it slides down + expands to its full TermChat-
                  bottom-docked position. */}
              <div
                className={`intro3-input-pad${inputReady ? " intro3-input-pad--visible" : ""}`}
                style={inputPadStyle}
              >
                <form
                  onSubmit={handleSubmit}
                  className="intro3-input mx-auto bg-elevated dark:bg-overlay-2 border border-border rounded-2xl px-4 py-3 shadow-[0_4px_24px_rgba(0,0,0,0.07)] ring-1 ring-overlay-1 focus-within:border-border-strong focus-within:ring-overlay-2 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    {/* Slash-command suggester. When the user starts a
                        line with `/` we (a) flip the field to plain
                        text (so it's no longer dot-masked) and (b)
                        show a ghost completion of the only command we
                        currently expose, `/back`. Tab or → at the end of
                        the input accepts the suggestion. */}
                    {(() => {
                      const slashStarted = step === "password" && draft.startsWith("/")
                      const suggestion = "/back"
                      const ghostRest = slashStarted && suggestion.startsWith(draft) && draft !== suggestion
                        ? suggestion.slice(draft.length)
                        : ""
                      const showAsPassword = step === "password" && !slashStarted
                      const acceptGhost = (e: React.KeyboardEvent<HTMLInputElement>) => {
                        if (!ghostRest) return
                        const atEnd = e.currentTarget.selectionStart === draft.length
                          && e.currentTarget.selectionEnd === draft.length
                        if (e.key === "Tab" || (e.key === "ArrowRight" && atEnd)) {
                          e.preventDefault()
                          setDraft(suggestion)
                        }
                      }
                      return (
                        <div className="relative flex-1 min-w-0">
                          {ghostRest && (
                            <div
                              aria-hidden="true"
                              className="pointer-events-none absolute inset-0 flex items-center text-[15px] leading-relaxed text-text-faint whitespace-pre font-sans"
                            >
                              <span className="invisible">{draft}</span>{ghostRest}
                              <span className="ml-2 text-[11px] uppercase tracking-wider opacity-60">tab</span>
                            </div>
                          )}
                          <input
                            ref={inputRef}
                            type={showAsPassword ? "password" : "text"}
                            value={draft}
                            onChange={(e) => { setDraft(e.target.value); if (error) setError(null) }}
                            onKeyDown={acceptGhost}
                            placeholder={
                              step === "done"
                                ? ""
                                : step === "password"
                                  ? "password  —  type / for shortcuts"
                                  : "your handle"
                            }
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            autoComplete={showAsPassword ? "current-password" : "off"}
                            autoFocus
                            disabled={inputDisabled || step === "done"}
                            aria-label={step}
                            className="relative w-full bg-transparent text-[15px] text-text placeholder:text-text-faint focus:outline-none leading-relaxed disabled:opacity-30"
                          />
                        </div>
                      )
                    })()}
                    <button
                      type="submit"
                      disabled={!canSend}
                      className="shrink-0 flex items-center justify-center w-9 h-9 bg-accent hover:bg-accent-hover text-text-on-accent rounded-lg transition-colors disabled:opacity-40"
                      title="Send"
                      aria-label="Send"
                    >
                      <Send size={16} />
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}

// ── Route-level wrapper ──────────────────────────────────────────────
// Hand-off from intro → platform is driven in stages so:
//   • no visible page-reload blip (App is mounted in-place)
//   • the input bar lands EXACTLY where the platform's own input bar
//     sits (mode="empty"  → centered TermChat welcome bar;
//             mode="chat" → bottom-docked TermChat input;
//             mode="nochat" → no landing target → input fades up)
//   • the morph timing waits for App to actually paint, so the
//     destination rect is real before we animate to it
export function IntroConversationRoute() {
  const [phase, setPhase] = useState<"intro" | "layered" | "fading" | "platform">("intro")
  const [enterTrigger, setEnterTrigger] = useState(false)
  const [morphMode, setMorphMode] = useState<IntroMorphMode>("chat")
  const [morphTarget, setMorphTarget] = useState<IntroMorphTarget | undefined>(undefined)

  const introMounted = phase !== "platform"
  const showApp      = phase !== "intro"

  // Decide morph mode from current store state (active view's widgets
  // + run history). Called once, the instant login succeeds.
  function detectMode(): IntroMorphMode {
    try {
      const s = useStore.getState()
      const view = s.views.find((v) => v.id === s.activeViewId) ?? s.views[0]
      const hasTermChat = !!view?.widgets?.some((w) => w.type === "term-chat")
      if (!hasTermChat) return "nochat"
      return (s.runs?.length ?? 0) === 0 ? "empty" : "chat"
    } catch {
      return "chat"
    }
  }

  // After App mounts (layered phase), wait for paint, then measure
  // the platform's TermChat input bar and trigger the entering morph.
  function measureAndTrigger(mode: IntroMorphMode) {
    // Two rAFs + a small settle gives App's Suspense / Grid time to
    // place its children at their final coordinates.
    const measure = () => {
      if (mode === "empty" || mode === "chat") {
        const el = document.querySelector<HTMLElement>('[data-intro-target="termchat-input"]')
        if (el) {
          const r = el.getBoundingClientRect()
          setMorphTarget({ left: r.left, top: r.top, width: r.width, height: r.height })
        }
      }
      setEnterTrigger(true)
    }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      window.setTimeout(measure, 120)
    }))
  }

  return (
    <div className="intro3-route-root" style={{ position: "relative", width: "100%", height: "100vh" }}>
      {showApp ? (
        <div
          className="intro3-route-app"
          style={{ position: "absolute", inset: 0, zIndex: 0 }}
        >
          <App />
        </div>
      ) : null}
      {introMounted ? (
        <div
          className={`intro3-route-overlay${phase === "fading" ? " intro3-route-overlay--fading" : ""}`}
          style={{ position: "absolute", inset: 0, zIndex: 1 }}
          onTransitionEnd={(e) => {
            if (phase === "fading" && e.propertyName === "opacity") setPhase("platform")
          }}
        >
          <IntroConversation
            morphMode={morphMode}
            morphTarget={morphTarget}
            enterTrigger={enterTrigger}
            onLoginSuccess={() => {
              try { window.history.replaceState(null, "", introBasePath()) } catch { /* ignore */ }
              const mode = detectMode()
              setMorphMode(mode)
              setPhase("layered")
              measureAndTrigger(mode)
            }}
            onEnteringStart={() => { /* phase already "layered" by onLoginSuccess */ }}
            onEntered={() => { setPhase("fading") }}
          />
        </div>
      ) : null}
    </div>
  )
}
