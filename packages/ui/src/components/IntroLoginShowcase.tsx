import { useEffect, useMemo, useRef, useState } from "react"

/**
 * /intro — a single-line login pill in the user's current theme.
 *
 * Visual goal: one calm element on the page; the body background is the
 * same canvas the main app uses, so the post-submit handoff is a quiet
 * fade rather than a route flash.
 */
export function IntroLoginShowcase() {
  const [step, setStep] = useState<"username" | "password">("username")
  const [username, setUsername] = useState("")
  const [draft, setDraft] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [entering, setEntering] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const previousTitle = document.title
    document.title = "MI:A"
    return () => { document.title = previousTitle }
  }, [])

  useEffect(() => {
    if (entering) return
    const focusInput = () => inputRef.current?.focus({ preventScroll: true })
    const raf = window.requestAnimationFrame(focusInput)
    return () => window.cancelAnimationFrame(raf)
  }, [step, entering])

  const basePath = useMemo(() => {
    const normalized = (import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "")
    return normalized || "/"
  }, [])

  const placeholder = error
    ? error
    : step === "username"
      ? "name"
      : "password"
  const activeDraft = step === "password" ? "•".repeat(draft.length) : draft

  async function loginOrRegister(nextUsername: string, password: string): Promise<void> {
    const post = (url: string, body: Record<string, unknown>) =>
      fetch(url, {
        method:      "POST",
        credentials: "include",
        headers:     { "content-type": "application/json" },
        body:        JSON.stringify(body),
      })

    const login = await post("/api/auth/login", { username: nextUsername, password })
    if (login.ok) return
    if (login.status === 401) {
      const reg = await post("/api/auth/register", {
        username: nextUsername,
        password,
        displayName: nextUsername,
      })
      if (reg.ok) return
      if (reg.status === 409) throw new Error("wrong password")
      const body = await reg.json().catch(() => ({})) as { error?: string }
      throw new Error(body.error ?? `sign-up failed (${reg.status})`)
    }
    const body = await login.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? `sign-in failed (${login.status})`)
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (submitting || entering) return
    const value = draft.trim()
    if (!value) return

    if (step === "username") {
      setUsername(value)
      setDraft("")
      setError(null)
      setStep("password")
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      await loginOrRegister(username, value)
      setEntering(true)
      // Wait for the orb-close animation to fully cover the viewport in
      // --canvas; the underlying body is already that colour so the
      // route swap reads as one continuous frame.
      window.setTimeout(() => {
        window.location.assign(basePath)
      }, 1050)
    } catch (err) {
      setSubmitting(false)
      setDraft("")
      setError(err instanceof Error ? err.message : "sign-in failed")
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && step === "password" && draft.length === 0 && !submitting && !entering) {
      e.preventDefault()
      setStep("username")
      setDraft(username)
      setUsername("")
      setError(null)
      return
    }
    if (e.key === "Escape" && step === "password" && !submitting && !entering) {
      setStep("username")
      setDraft(username)
      setUsername("")
      setError(null)
    }
  }

  // Build the read-only display as a flat list of segments so the JSX
  // stays a single shape for both steps.
  const segments: Array<{ kind: "prefix" | "muted" | "active" | "sep"; text: string }> = [
    { kind: "prefix", text: "/mia" },
  ]
  if (step === "password") {
    segments.push({ kind: "sep", text: "/" })
    segments.push({ kind: "muted", text: username })
  }
  if (draft.length > 0) {
    segments.push({ kind: "sep", text: "/" })
    segments.push({ kind: "active", text: activeDraft })
  }

  return (
    <main className="intro-page" aria-label="mia-entry intro">
      <form
        className={`intro-centerbar${entering ? " intro-centerbar--entering" : ""}${error ? " intro-centerbar--error" : ""}`}
        onSubmit={handleSubmit}
      >
        <div className="intro-centerbar__rail">
          <div className="intro-centerbar__display" aria-hidden="true">
            {segments.map((s, i) => (
              <span key={i} className={`intro-centerbar__segment intro-centerbar__segment--${s.kind}`}>{s.text}</span>
            ))}
            <span className="intro-centerbar__prompt">/</span>
            {draft.length === 0 ? (
              <span className="intro-centerbar__placeholder">{placeholder}</span>
            ) : null}
          </div>
          <input
            ref={inputRef}
            className="intro-centerbar__input"
            type={step === "password" ? "password" : "text"}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              if (error) setError(null)
            }}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete={step === "password" ? "current-password" : "username"}
            spellCheck={false}
            autoFocus
            disabled={submitting || entering}
            aria-label={step === "password" ? "password" : "username"}
          />
        </div>
      </form>
    </main>
  )
}
