import { Send } from "lucide-react"
import { useState } from "react"

/**
 * AskUserPrompt — the card the agent shows when it calls `ask_user`.
 *
 * Robustness contract (the fix for the "Response sent — waiting for agent"
 * hang): the card must NOT claim success until the server has actually
 * accepted the response, and it must surface a failure so the user can retry
 * instead of staring at a frozen "waiting" state while the agent never
 * receives the answer.
 *
 *   - `onSubmit` returns a Promise that resolves only on HTTP success and
 *     rejects on failure (404 / network / etc.).
 *   - `submitted` ("waiting") is set ONLY after `onSubmit` resolves.
 *   - On rejection we show an error line and re-enable the form so the user
 *     can try again (e.g. after a server restart that lost the in-memory
 *     resolver, or a stale/reloaded prompt card).
 */
export function AskUserPrompt({
  question,
  options,
  sensitive,
  onSubmit,
}: {
  question: string
  options?: string[]
  sensitive?: boolean
  onSubmit: (response: string) => Promise<void> | void
}) {
  const [value, setValue] = useState("")
  // True only after the server has accepted the response — the honest
  // "waiting for agent" state. Before this, the card is still answerable.
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  async function submit(response: string) {
    if (submitted || sending) return
    const trimmed = response.trim()
    if (!trimmed) return
    setError(null)
    setSending(true)
    try {
      await onSubmit(trimmed)
      setSubmitted(true)
    } catch (err) {
      // Server rejected (404 no pending input / run gone / network). Do NOT
      // lock the card — let the user retry. The most common cause is the run
      // no longer being answerable (server restart lost the in-memory
      // resolver, or the run already ended).
      const detail = err instanceof Error ? err.message : String(err)
      setError(detail || "Could not send response. The run may have ended.")
      setSending(false)
    }
  }

  return (
    <div
      className="rounded-xl border border-accent/40 bg-accent/5 overflow-hidden"
      onClick={(e) => e.stopPropagation()}
      aria-busy={submitted || sending || undefined}
    >
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <span className="relative flex shrink-0 h-2 w-2">
          <span className="relative inline-flex rounded-full h-2 w-2 bg-accent/85" />
        </span>
        <span
          className="text-[15px] font-semibold uppercase tracking-wide text-text"
          style={{ color: "var(--color-text, rgb(244 244 245))" }}
        >
          {submitted
            ? "Response sent — waiting for agent"
            : error
              ? "Could not send response"
              : "Agent needs your input"}
        </span>
      </div>

      <p
        className="px-3 pb-3 text-[15px] leading-relaxed text-text"
        style={{ color: "var(--color-text, rgb(244 244 245))" }}
      >
        {question}
      </p>

      {error && !submitted && (
        <p
          className="mx-3 mb-3 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-[14px] text-error"
        >
          {error} — you can try again, or stop the run.
        </p>
      )}

      {options && options.length > 0 && (
        <div className="px-3 pb-3 flex flex-wrap gap-2">
          {options.map((option, index) => (
            <button
              key={`${index}-${option}`}
              type="button"
              disabled={submitted || sending}
              className="px-3 py-1.5 rounded-lg border border-accent/30 bg-overlay-2 text-[15px] text-text hover:bg-accent/10 hover:border-accent/60 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-overlay-2 disabled:hover:border-accent/30"
              onClick={() => submit(option)}
            >
              {option}
            </button>
          ))}
        </div>
      )}

      <div className="px-3 pb-3 flex gap-2">
        <input
          autoFocus
          type={sensitive ? "password" : "text"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          readOnly={submitted || sending}
          disabled={submitted || sending}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              submit(value)
            }
          }}
          placeholder={sensitive ? "••••••••" : "Type your response…"}
          className="flex-1 min-w-0 bg-overlay-2 border border-border rounded-lg px-3 py-2 text-[15px] text-text placeholder:text-text-muted focus:outline-none focus:border-accent/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        />
        <button
          type="button"
          className="shrink-0 flex items-center justify-center w-9 h-9 bg-accent hover:bg-accent-hover text-text rounded-lg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-accent"
          disabled={submitted || sending || !value.trim()}
          onClick={() => submit(value)}
          aria-label={submitted ? "Response already sent" : "Send response"}
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  )
}
