import { ArrowUp, LayoutGrid, LogOut } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { useServerReachable } from "../hooks/useServerReachable"
import {
    HOME_CHAT_COLUMN_CLASS,
    HOME_CHAT_GUTTER_X_CLASS,
    HOME_CHAT_INPUT_DOCK_CLASS,
} from "../shell/chatLayout.js"
import { ASCII_FIELD_SCRAMBLE_GLYPHS } from "../shell/asciiNoise"
import { IntroAsciiField, type IntroAsciiRenderTarget } from "./IntroAsciiField"
import { IntroBrandWordmark } from "./intro/IntroBrandWordmark"
import { CrystalText, StreamingText } from "./intro/IntroChatText"

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

/** If the user reads but never types, settle the header without leaving MI:A stuck. */
const BRAND_RESOLVE_IDLE_FALLBACK_MS = 10_000

function wmRandomGlyph(seed: number): string {
  const i = Math.abs((seed * 9301 + 49297) % ASCII_FIELD_SCRAMBLE_GLYPHS.length)
  return ASCII_FIELD_SCRAMBLE_GLYPHS[i]!
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms))
}

// ── Decay text — outro scramble. Letters R→L go locked → scrambling
//    → hidden (encrypted-then-gone), mirroring WelcomeIntro's outro. ──
const DECAY_LEAD_MS     = 240
const DECAY_STEP_MS     = 35
const DECAY_SCRAMBLE_MS = 110
const DECAY_TICK_MS     = 45
type DecayCellState = "locked" | "scrambling" | "hidden"
interface DecayCell { state: DecayCellState; glyph: string }

function DecayText({
  text,
  active,
  direction = "rtl",
}: {
  text: string
  active: boolean
  direction?: "ltr" | "rtl"
}) {
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
        if (direction === "ltr") {
          for (let i = 0; i < text.length; i++) {
            const startAt = i * DECAY_STEP_MS
            const goneAt = startAt + DECAY_SCRAMBLE_MS
            if (elapsed < startAt) continue
            if (elapsed >= goneAt) {
              if (next[i]!.state !== "hidden") next[i] = { state: "hidden", glyph: "" }
            } else {
              next[i] = { state: "scrambling", glyph: wmRandomGlyph(Math.floor(now) + i * 17) }
            }
          }
          return next
        }
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
  }, [active, text, direction])

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
 *   - Header brand (MI: → pinch spawns A → retract on first keystroke → live :)
 *     runs beside the intro — ASCII field, bot greeting, input pill, login
 *     morph. Resolve is user-paced so it never fights the opening question.
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
  const [userEngaged, setUserEngaged] = useState(false)
  const userEngagedRef = useRef(false)
  const engageBrandResolve = () => {
    if (userEngagedRef.current) return
    userEngagedRef.current = true
    setUserEngaged(true)
  }
  const autoplayPhaseRef = useRef<"idle" | "username" | "password" | "done">("idle")
  // Resolved when the header brand finishes MI: + pinch-spawn-A (opening beat only).
  const brandReadyRef = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null)
  if (!brandReadyRef.current) {
    let resolve: () => void = () => {}
    const promise = new Promise<void>((r) => { resolve = r })
    brandReadyRef.current = { promise, resolve }
  }
  // Resolved when the ambient ASCII field finishes rolling out from left
  // to right. We hold the opening "who am I talking to?" until then so
  // the screen reads as: wordmark → field arrives → bot greets.
  const asciiReadyRef = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null)
  if (!asciiReadyRef.current) {
    let resolve: () => void = () => {}
    const promise = new Promise<void>((r) => { resolve = r })
    asciiReadyRef.current = { promise, resolve }
  }
  const inputRef  = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const { reachable: serverReachable } = useServerReachable(true)

  useEffect(() => {
    const t = document.title
    document.title = "MI:A"
    return () => { document.title = t }
  }, [])

  // Opening: brand + ASCII in parallel → bot greeting → input. Brand resolve
  // waits until the user types (or idle fallback) so header motion never
  // competes with reading "who am I talking to?".
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      await Promise.all([
        brandReadyRef.current!.promise,
        asciiReadyRef.current!.promise,
      ])
      if (cancelled) return
      await botReply("who am I talking to?", "Loading", 600)
      if (cancelled) return
      setInputReady(true)
    }
    void run()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!inputReady || userEngaged) return
    const t = window.setTimeout(engageBrandResolve, BRAND_RESOLVE_IDLE_FALLBACK_MS)
    return () => window.clearTimeout(t)
  }, [inputReady, userEngaged])

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
    engageBrandResolve()

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
      <div className="chathome-frame pointer-events-none absolute inset-0 z-0 overflow-hidden">
        <IntroAsciiField surface="login" onReady={() => asciiReadyRef.current?.resolve()} />
      </div>

      <div className="relative z-10 flex min-h-0 flex-1 flex-col">

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

      <header className="intro3-header relative flex h-12 shrink-0 items-center justify-between px-4 sm:h-14 sm:px-6 select-none">
        <div className="toolbar-brand flex h-9 shrink-0 items-center text-text">
          <IntroBrandWordmark
            onBrandReady={() => brandReadyRef.current?.resolve()}
            beginResolve={inputReady && userEngaged}
            serverReachable={serverReachable}
          />
        </div>
        <div className="intro3-shell-actions flex items-center gap-2" aria-hidden="true">
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

      {/* Main chat column — 1:1 with ChatHomePage → TermChat home layout. */}
      <main className="intro3-stage flex min-h-0 flex-1 flex-col">
        <div className="relative flex h-full min-h-0 flex-col bg-transparent font-sans text-text">
          <div
            ref={scrollRef}
            className={`intro3-scroll-area relative min-h-0 flex-1 overflow-y-auto ${HOME_CHAT_GUTTER_X_CLASS} pb-4 pt-0 space-y-6`}
          >
            <div className={`intro3-scroll-inner relative ${HOME_CHAT_COLUMN_CLASS} space-y-6`}>
              {msgs.map((m, i) => {
                const isLast = i === msgs.length - 1
                if (m.role === "user") {
                  return (
                    <div key={i} className="flex justify-end">
                      <div className="max-w-[82%] min-w-0">
                        <div
                          className="intro3-bubble-user max-w-full overflow-hidden rounded-2xl border border-border-subtle bg-panel-2 px-5 py-3 text-[15px] leading-relaxed text-text dark:bg-bubble-user"
                          style={{ boxShadow: "var(--shadow-bubble)" }}
                        >
                          {m.text}
                        </div>
                      </div>
                    </div>
                  )
                }
                return (
                  <div key={i} className="text-[15px] font-medium leading-relaxed text-text">
                    {isLast && !entering ? <StreamingText text={m.text} /> : m.text}
                  </div>
                )
              })}
              <div className="intro3-activity-slot py-1.5 pr-2">
                {botTyping ? (
                  <span className="activity-shimmer-tight inline-block text-[13px] font-medium leading-6 text-text-muted">
                    <CrystalText text={shimmerLabel} />
                  </span>
                ) : null}
              </div>
            </div>
          </div>

          <div
            className={`intro3-input-pad${inputReady ? " intro3-input-pad--visible" : ""} ${HOME_CHAT_INPUT_DOCK_CLASS}`}
          >
            <div ref={loginPillRef} className={`relative z-20 ${HOME_CHAT_COLUMN_CLASS}`}>
              <form
                data-intro-target="termchat-input"
                onSubmit={handleSubmit}
                className="intro3-input chathome-chrome-pill mx-auto w-full rounded-[24px] border border-border bg-elevated px-5 py-4 ring-1 ring-overlay-1 transition-colors focus-within:border-border-strong focus-within:ring-overlay-2 dark:bg-overlay-2"
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
                            onChange={(e) => {
                              if (e.target.value.length > 0) engageBrandResolve()
                              setDraft(e.target.value)
                              if (error) setError(null)
                            }}
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
                    <div className="flex items-center justify-end gap-3 pt-1.5">
                      <button
                        type="submit"
                        disabled={!canSend}
                        className="shrink-0 flex items-center justify-center w-10 h-10 bg-overlay-2 hover:bg-overlay-hover text-text-muted hover:text-text rounded-xl transition-colors disabled:opacity-30"
                        title="Send"
                        aria-label="Send"
                      >
                        <ArrowUp size={18} />
                      </button>
                    </div>
                  </div>
                </form>
            </div>
          </div>
        </div>
      </main>
      </div>
    </div>
  )
}

// ── Route-level wrapper ──────────────────────────────────────────────
