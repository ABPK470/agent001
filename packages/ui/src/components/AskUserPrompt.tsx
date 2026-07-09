import { Send } from "lucide-react"
import { useState } from "react"

export function AskUserPrompt({
  question,
  options,
  sensitive,
  onSubmit,
}: {
  question: string
  options?: string[]
  sensitive?: boolean
  onSubmit: (response: string) => void
}) {
  const [value, setValue] = useState("")
  // Once the user submits a response, the agent has received it and the
  // request is no longer answerable. Re-clicking Send (or pressing Enter
  // again, or clicking an option chip) used to fire onSubmit a second
  // time, which the orchestrator drops but which still looks alive in
  // the UI. Lock the entire prompt — input, option chips, and Send —
  // once we've handed off the first response.
  const [submitted, setSubmitted] = useState(false)

  function submit(response: string) {
    if (submitted) return
    const trimmed = response.trim()
    if (!trimmed) return
    setSubmitted(true)
    onSubmit(trimmed)
  }

  return (
    <div
      className="rounded-xl border border-accent/40 bg-accent/5 overflow-hidden"
      onClick={(e) => e.stopPropagation()}
      aria-busy={submitted || undefined}
    >
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <span className="relative flex shrink-0 h-2 w-2">
          <span className="relative inline-flex rounded-full h-2 w-2 bg-accent/85" />
        </span>
        <span
          className="text-base font-semibold uppercase tracking-wide text-text"
          style={{ color: "var(--color-text, rgb(244 244 245))" }}
        >
          {submitted ? "Response sent — waiting for agent" : "Agent needs your input"}
        </span>
      </div>

      <p
        className="px-3 pb-3 text-base leading-relaxed text-text"
        style={{ color: "var(--color-text, rgb(244 244 245))" }}
      >
        {question}
      </p>

      {options && options.length > 0 && (
        <div className="px-3 pb-3 flex flex-wrap gap-2">
          {options.map((option, index) => (
            <button
              key={`${index}-${option}`}
              type="button"
              disabled={submitted}
              className="px-3 py-1.5 rounded-lg border border-accent/30 bg-overlay-2 text-base text-text hover:bg-accent/10 hover:border-accent/60 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-overlay-2 disabled:hover:border-accent/30"
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
          readOnly={submitted}
          disabled={submitted}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              submit(value)
            }
          }}
          placeholder={sensitive ? "••••••••" : "Type your response…"}
          className="flex-1 min-w-0 bg-overlay-2 border border-border rounded-lg px-3 py-2 text-base text-text placeholder:text-text-muted focus:outline-none focus:border-accent/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        />
        <button
          type="button"
          className="shrink-0 flex items-center justify-center w-9 h-9 bg-accent hover:bg-accent-hover text-text rounded-lg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-accent"
          disabled={submitted || !value.trim()}
          onClick={() => submit(value)}
          aria-label={submitted ? "Response already sent" : "Send response"}
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  )
}