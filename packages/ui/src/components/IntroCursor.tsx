import { useEffect, useRef, useState } from "react"
import { IntroSwitcher, introBasePath, loginOrRegister } from "./introShared"

/**
 * /intro — "the cursor IS the agent".
 *
 * One blinking caret centred on the canvas. Type → glyphs grow to the
 * left of the caret. Enter on username → the typed name floats up as a
 * faint stripe above the caret and the caret accepts the password.
 * Enter on password → caret + glyphs ease upward and fade; the same
 * canvas the app paints on is already underneath.
 *
 * No pill. No border. No background. The agent is a point of attention.
 */
export function IntroCursor() {
  const [step, setStep]             = useState<"username" | "password">("username")
  const [username, setUsername]     = useState("")
  const [draft, setDraft]           = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [entering, setEntering]     = useState(false)
  const [error, setError]           = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const t = document.title
    document.title = "MI:A"
    return () => { document.title = t }
  }, [])

  useEffect(() => {
    if (entering) return
    const raf = window.requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
    return () => window.cancelAnimationFrame(raf)
  }, [step, entering])

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (submitting || entering) return
    const value = draft.trim()
    if (!value) return

    if (step === "username") {
      setUsername(value); setDraft(""); setError(null); setStep("password")
      return
    }
    setSubmitting(true); setError(null)
    try {
      await loginOrRegister(username, value)
      setEntering(true)
      window.setTimeout(() => window.location.assign(introBasePath()), 900)
    } catch (err) {
      setSubmitting(false); setDraft("")
      setError(err instanceof Error ? err.message : "sign-in failed")
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && step === "password" && draft.length === 0 && !submitting && !entering) {
      e.preventDefault()
      setStep("username"); setDraft(username); setUsername(""); setError(null)
    }
  }

  const visible = step === "password" ? "•".repeat(draft.length) : draft

  return (
    <main
      className={`intro-cursor${entering ? " intro-cursor--entering" : ""}${error ? " intro-cursor--error" : ""}`}
      onClick={() => inputRef.current?.focus()}
      aria-label="mia-entry cursor"
    >
      <form className="intro-cursor__stage" onSubmit={handleSubmit}>
        {step === "password" && username ? (
          <div className="intro-cursor__history">{username}</div>
        ) : null}

        <div className="intro-cursor__line">
          <span className="intro-cursor__draft">{visible}</span>
          <span className="intro-cursor__caret" aria-hidden="true" />
        </div>

        <div className={`intro-cursor__hint${error ? " intro-cursor__hint--error" : ""}`}>
          {error ?? (step === "username" ? "your handle · enter" : "password · enter")}
        </div>

        <input
          ref={inputRef}
          className="intro-cursor__input"
          type={step === "password" ? "password" : "text"}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); if (error) setError(null) }}
          onKeyDown={handleKeyDown}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete={step === "password" ? "current-password" : "username"}
          autoFocus
          disabled={submitting || entering}
          aria-label={step}
        />
      </form>

      <IntroSwitcher current={1} />
    </main>
  )
}
