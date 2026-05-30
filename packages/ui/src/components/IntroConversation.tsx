import { ExternalLink, LayoutGrid, LogOut, Plus, Send, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { ASCII_SCRAMBLE_GLYPHS, IntroAsciiField, type IntroAsciiRenderTarget } from "./IntroAsciiField"
import { Logo } from "./Logo"

interface Msg { role: "bot" | "user"; text: string; streamed?: boolean }

// Default auth call used when the parent doesn't pass `onLogin`. Tries
// login, falls back to register on 401, treats 409 on register as the
// "username exists, wrong password" case.
async function loginOrRegister(username: string, password: string): Promise<void> {
  const post = (url: string, body: Record<string, unknown>) =>
    fetch(url, {
      method:      "POST",
      credentials: "include",
      headers:     { "content-type": "application/json" },
      body:        JSON.stringify(body),
    })

  const login = await post("/api/auth/login", { username, password })
  if (login.ok) return
  if (login.status === 401) {
    const reg = await post("/api/auth/register", {
      username, password, displayName: username,
    })
    if (reg.ok) return
    if (reg.status === 409) throw new Error("wrong password")
    const body = await reg.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? `sign-up failed (${reg.status})`)
  }
  const body = await login.json().catch(() => ({})) as { error?: string }
  throw new Error(body.error ?? `sign-in failed (${login.status})`)
}

// Resolves Vite's BASE_URL to a normalised root path the standalone
// post-login redirect path uses.
function introBasePath(): string {
  const normalized = (import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "")
  return normalized || "/"
}

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

export function MiaWordmark() {
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
 * Conversational login surface — the intro3-derived design that now
 * powers the real login flow.
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
  onPillRevealProgress,
  onLoginSuccess,
  onLogin,
  enterTrigger = false,
  morphMode = "chat",
  morphTarget,
  autoplay,
}: {
  onEntered?: () => void
  onEnteringStart?: () => void
  onPillRevealProgress?: (progress: number) => void
  /** Fired right after "come in." finishes streaming, BEFORE the morph
   *  begins. Parent uses this to mount the platform underneath and
   *  measure the target landing rect for the input bar. */
  onLoginSuccess?: () => void
  /** Optional override for the auth call. When unset, falls back to the
   *  module-local `loginOrRegister` (same contract). The
   *  embedded-in-App.tsx case passes its own version so the parent's
   *  refreshMe() / phase logic stay in charge. */
  onLogin?: (username: string, password: string) => Promise<void>
  /** Parent flips to true once App is painted + target measured. When
   *  this becomes true the intro triggers its entering morph. */
  enterTrigger?: boolean
  morphMode?: IntroMorphMode
  morphTarget?: IntroMorphTarget
  /** Optional test-only helper that auto-submits username/password so
   *  the transition can be replayed without manual login cycles. */
  autoplay?: {
    username?: string
    password?: string
    stepDelayMs?: number
  }
} = {}) {
  const [step, setStep]             = useState<"username" | "password" | "done">("username")
  const [username, setUsername]     = useState("")
  const [draft, setDraft]           = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [entering, setEntering]     = useState(false)
  const [enterProgress, setEnterProgress] = useState(0)
  const [error, setError]           = useState<string | null>(null)
  const [botTyping, setBotTyping]   = useState(false)
  const [shimmerLabel, setShimmerLabel] = useState<string>("Loading")
  // The first bot message is not seeded — it's spoken (shimmer + stream)
  // only after the MI:A wordmark finishes decoding so the screen unfolds
  // in sequence: wordmark → bot greeting → input bar.
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [inputReady, setInputReady] = useState(false)
  const autoplayPhaseRef = useRef<"idle" | "username" | "password" | "done">("idle")
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

  async function submitValue(value: string) {
    if (submitting || entering) return
    if (!value) return

    if (step === "username") {
      // Mirror server-side rule from auth/users.ts so we never advance
      // to the password step with an invalid handle. The bot echoes the
      // exact same wording the server would return.
      if (!/^[A-Za-z0-9._-]{2,64}$/.test(value)) {
        push("user", value)
        setDraft("")
        await botReply("username must be 2-64 chars, [A-Za-z0-9._-] — try again.", "Thinking", 300)
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

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    await submitValue(draft.trim())
  }

  useEffect(() => {
    if (!autoplay || entering || submitting || botTyping || !inputReady) return
    if (step === "done") {
      autoplayPhaseRef.current = "done"
      return
    }
    const stepDelayMs = autoplay.stepDelayMs ?? 420
    if (step === "username" && autoplayPhaseRef.current === "idle") {
      autoplayPhaseRef.current = "username"
      const t = window.setTimeout(() => {
        void submitValue((autoplay.username ?? "test-user").trim())
      }, stepDelayMs)
      return () => window.clearTimeout(t)
    }
    if (step === "password" && autoplayPhaseRef.current === "username") {
      autoplayPhaseRef.current = "password"
      const t = window.setTimeout(() => {
        void submitValue((autoplay.password ?? "test-pass").trim())
      }, stepDelayMs)
      return () => window.clearTimeout(t)
    }
  }, [autoplay, botTyping, entering, inputReady, step, submitting])

  const inputDisabled = submitting || entering || botTyping
  const canSend = draft.trim().length > 0 && !inputDisabled

  // Ref to the login input pad so we can measure its actual current
  // screen rect at entering time. The focus mask is anchored to THIS
  // rect, not the chathome destination — the pill must stay where it
  // is and be consumed in place by the ASCII.
  const loginPillRef = useRef<HTMLDivElement | null>(null)
  const [loginPillRect, setLoginPillRect] = useState<
    { left: number; top: number; width: number; height: number } | null
  >(null)

  // Parent-driven morph trigger: when enterTrigger flips true we kick
  // off the entering animation and schedule the "morph done" hand-off.
  useEffect(() => {
    if (!enterTrigger || entering) return
    if (onEnteringStart) onEnteringStart()
    // Measure the login pill BEFORE flipping to entering so the focus
    // mask is anchored on the pill's current resting position. (After
    // entering=true the pill starts fading; rect should be unaffected
    // but we capture it first to be safe.)
    const el = loginPillRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      setLoginPillRect({ left: r.left, top: r.top, width: r.width, height: r.height })
    }
    setEntering(true)
    const morphMs = 1500
    setEnterProgress(0)
    onPillRevealProgress?.(0)
    const startedAt = performance.now()
    let rafId = 0
    const tickProgress = (now: number) => {
      const nextProgress = Math.max(0, Math.min(1, (now - startedAt) / morphMs))
      setEnterProgress(nextProgress)
      onPillRevealProgress?.(nextProgress)
      if (nextProgress < 1) {
        rafId = window.requestAnimationFrame(tickProgress)
      }
    }
    rafId = window.requestAnimationFrame(tickProgress)
    const t = window.setTimeout(() => {
      setEnterProgress(1)
      onPillRevealProgress?.(1)
      onEntered?.()
    }, morphMs)
    return () => {
      window.cancelAnimationFrame(rafId)
      window.clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enterTrigger])

  // Login pill stays put during the morph — it's consumed in place by
  // the boosted ASCII, not teleported to the chathome destination.
  const inputPadStyle: React.CSSProperties | undefined = undefined

  const introPillActivityStyle = useMemo<CSSProperties | undefined>(() => {
    if (!loginPillRect) return undefined
    const width = loginPillRect.width * 2.2
    const height = loginPillRect.height * 4.2
    const build = Math.max(0, Math.min(1, (enterProgress - 0.02) / 0.34))
    const buildEase = build * build * (3 - 2 * build)
    const decayBase = Math.max(0, Math.min(1, (enterProgress - 0.66) / 0.34))
    const decayEase = decayBase * decayBase * (3 - 2 * decayBase)
    const opacity = 0.82 * buildEase * (1 - decayEase)
    const scale = 0.9 + 0.12 * Math.max(0, Math.min(1, enterProgress / 0.84))
    const saturation = 1.01 + 0.14 * buildEase - 0.18 * decayEase
    const brightness = 1.01 + 0.08 * buildEase - 0.1 * decayEase
    return {
      left: `${loginPillRect.left + loginPillRect.width / 2}px`,
      top: `${loginPillRect.top + loginPillRect.height / 2}px`,
      width: `${width}px`,
      height: `${height}px`,
      opacity,
      transform: `translate3d(-50%, -50%, 0) scale(${scale})`,
      filter: `saturate(${saturation}) brightness(${brightness})`,
    }
  }, [enterProgress, loginPillRect])

  const introPillActivityTarget = useMemo<IntroAsciiRenderTarget | undefined>(() => {
    if (!loginPillRect) return undefined
    const width = loginPillRect.width * 2.2
    const height = loginPillRect.height * 4.2
    return {
      left: (width - loginPillRect.width) / 2,
      top: (height - loginPillRect.height) / 2,
      width: loginPillRect.width,
      height: loginPillRect.height,
      radius: Math.min(24, loginPillRect.height / 2),
      mode: "activity",
      stage: "pill",
      progress: enterProgress,
    }
  }, [enterProgress, loginPillRect])

  // Publish only the live LOGIN pill rect. The consume/reveal effect is
  // intentionally local to the current pill position; the destination
  // shell should be revealed underneath rather than visually morphed to.
  const rootStyle: React.CSSProperties = loginPillRect
    ? ({
        "--pill-cx": `${loginPillRect.left + loginPillRect.width / 2}px`,
        "--pill-cy": `${loginPillRect.top + loginPillRect.height / 2}px`,
        "--pill-w": `${loginPillRect.width}px`,
        "--pill-h": `${loginPillRect.height}px`,
      } as React.CSSProperties)
    : {}

  return (
    <div
      className={`intro3-root intro3-mode-${morphMode}${entering ? " intro3-root--entering" : ""}`}
      style={rootStyle}
      aria-label="mia-entry conversation"
    >
      {/* Generative ASCII texture — ambient life behind the conversation.
          Fades out during the morph so it doesn't bleed into the platform. */}
      <IntroAsciiField onReady={() => asciiReadyRef.current?.resolve()} />

      {/* Pill-area focus — mounted only during the entering morph so
          the boosted ASCII field MATERIALIZES per-cell each time
          (organic appearance, exactly like the bg field on login load).
          Same shared startTs so its glyphs line up with the bg field.
          Soft elliptical mask sized to the pill rect + halo keeps the
          active area shaped around the pill (no hard circle). The pill
          fades into it; when the field dissolves the new pill is
          uncovered underneath. */}
      {entering ? (
        <div className="intro3-pill-focus" aria-hidden="true">
          <div
            className="intro3-pill-focus__activity"
            style={introPillActivityStyle}
          >
            <IntroAsciiField boost renderTarget={introPillActivityTarget} />
          </div>
        </div>
      ) : null}

      {/* Platform-shaped header — bg fades in from transparent → bg-canvas
          during the morph. Matches Toolbar's h-14 px-3 sm:px-6. */}
      <header className="intro3-header flex items-center px-3 sm:px-6 h-14 shrink-0 select-none gap-2 sm:gap-4">
        <div className="flex items-center gap-2.5 shrink-0">
          <Logo size={30} online />
          <MiaWordmark />
        </div>
        <div className="intro3-shell-actions ml-auto flex items-center gap-2" aria-hidden="true">
          <button
            type="button"
            className="intro3-shell-action flex h-10 w-10 items-center justify-center rounded-full"
            tabIndex={-1}
          >
            <LayoutGrid size={17} />
          </button>
          <button
            type="button"
            className="intro3-shell-action flex h-10 w-10 items-center justify-center rounded-full"
            tabIndex={-1}
          >
            <LogOut size={16} />
          </button>
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
                <div className="intro3-scroll-inner w-[90%] max-w-[840px] min-h-full mx-auto flex flex-col">
                  <div className="w-full max-w-[840px] mx-auto space-y-4">
                    {msgs.map((m, i) => {
                      const isLast = i === msgs.length - 1
                      if (m.role === "user") {
                        return (
                          <div key={i} className="flex justify-end">
                            <div
                              className="intro3-bubble-user max-w-[82%] px-4 py-2.5 bg-panel-2 dark:bg-bubble-user border border-border-subtle rounded-2xl text-[15px] text-text leading-relaxed"
                              style={{ boxShadow: "var(--shadow-bubble)" }}
                            >
                              {m.text}
                            </div>
                          </div>
                        )
                      }
                      // Bot: stream the latest, lock prior ones. On the
                      // entry morph every bubble decays (encrypt-out) in
                      // sync with the chrome reveal.
                      return (
                        <div key={i} className="text-[15px] text-text leading-relaxed font-medium">
                          {isLast && !entering
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
                ref={loginPillRef}
                className={`intro3-input-pad${inputReady ? " intro3-input-pad--visible" : ""}`}
                style={inputPadStyle}
              >
                <form
                  onSubmit={handleSubmit}
                  className="intro3-input mx-auto bg-elevated dark:bg-overlay-2 border border-border rounded-[24px] px-5 py-4 shadow-[0_4px_24px_rgba(0,0,0,0.07)] ring-1 ring-overlay-1 focus-within:border-border-strong focus-within:ring-overlay-2 transition-colors"
                >
                  <div className="flex flex-col gap-3">
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
                            className="relative w-full bg-transparent text-[15px] text-text placeholder:text-text-faint focus:outline-none leading-6 disabled:opacity-30"
                          />
                        </div>
                      )
                    })()}
                    <div className="flex items-center justify-between gap-3 pt-1.5">
                      <button
                        type="button"
                        className="shrink-0 flex items-center justify-center w-10 h-10 rounded-xl text-text-muted bg-overlay-2/70"
                        tabIndex={-1}
                        aria-hidden="true"
                      >
                        <Plus size={18} />
                      </button>
                      <button
                        type="submit"
                        disabled={!canSend}
                        className="shrink-0 flex items-center justify-center w-10 h-10 bg-overlay-2 hover:bg-overlay-hover text-text-muted hover:text-text rounded-xl transition-colors disabled:opacity-30"
                        title="Send"
                        aria-label="Send"
                      >
                        <Send size={18} />
                      </button>
                    </div>
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
