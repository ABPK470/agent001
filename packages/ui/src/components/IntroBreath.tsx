import { useEffect, useRef, useState } from "react"
import { IntroSwitcher, introBasePath, loginOrRegister } from "./introShared"

/**
 * /intro2 — "one breath".
 *
 * A single 12px dot, centred, breathing on a 3.6s cycle. The dot is
 * the agent's idle presence. Focus it and it stretches horizontally
 * into a thin line that accepts text. Submit username → line briefly
 * flashes and prompts for password. Submit password → on success the
 * line contracts back to a dot, the dot pulses thrice, then scales
 * out as the route hands over.
 *
 * The dot is meant to be promoted: in a real wiring the same element
 * would persist into the app as the live status indicator. Pre- and
 * post-login are the same world; logging in just gives the always-
 * present thing your attention.
 */
export function IntroBreath() {
  const [step, setStep]             = useState<"username" | "password">("username")
  const [username, setUsername]     = useState("")
  const [draft, setDraft]           = useState("")
  const [active, setActive]         = useState(false)
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
      window.setTimeout(() => window.location.assign(introBasePath()), 1200)
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

  // The field is "open" whenever there's text or the user has focused it.
  const open = active || draft.length > 0

  return (
    <main
      className={[
        "intro-breath",
        open       ? "intro-breath--open"     : "",
        entering   ? "intro-breath--entering" : "",
        error      ? "intro-breath--error"    : "",
        submitting ? "intro-breath--thinking" : "",
      ].filter(Boolean).join(" ")}
      onClick={() => inputRef.current?.focus()}
      aria-label="mia-entry breath"
    >
      <form className="intro-breath__stage" onSubmit={handleSubmit}>
        {step === "password" && username ? (
          <div className="intro-breath__label">{username}</div>
        ) : null}

        <div className="intro-breath__field">
          <span className="intro-breath__shape" aria-hidden="true" />
          <input
            ref={inputRef}
            className="intro-breath__input"
            type={step === "password" ? "password" : "text"}
            value={draft}
            placeholder={error ?? (step === "username" ? "name" : "password")}
            onChange={(e) => { setDraft(e.target.value); if (error) setError(null) }}
            onFocus={() => setActive(true)}
            onBlur={() => setActive(false)}
            onKeyDown={handleKeyDown}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete={step === "password" ? "current-password" : "username"}
            autoFocus
            disabled={submitting || entering}
            aria-label={step}
          />
        </div>
      </form>

      <IntroSwitcher current={2} />
    </main>
  )
}
