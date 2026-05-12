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

  function submit(response: string) {
    const trimmed = response.trim()
    if (!trimmed) return
    onSubmit(trimmed)
  }

  return (
    <div
      className="rounded-xl border border-accent/40 bg-accent/5 overflow-hidden"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <span className="relative flex shrink-0 h-2 w-2">
          <span className="relative inline-flex rounded-full h-2 w-2 bg-accent/85" />
        </span>
        <span
          className="text-base font-semibold uppercase tracking-wide text-text"
          style={{ color: "var(--color-text, rgb(244 244 245))" }}
        >
          Agent needs your input
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
          {options.map((option) => (
            <button
              key={option}
              className="px-3 py-1.5 rounded-lg border border-accent/30 bg-overlay-2 text-base text-text hover:bg-accent/10 hover:border-accent/60 transition-colors"
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
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              submit(value)
            }
          }}
          placeholder={sensitive ? "••••••••" : "Type your response…"}
          className="flex-1 min-w-0 bg-overlay-2 border border-border rounded-lg px-3 py-2 text-base text-text placeholder:text-text-muted focus:outline-none focus:border-accent/50 transition-colors"
        />
        <button
          className="shrink-0 flex items-center justify-center w-9 h-9 bg-accent hover:bg-accent-hover text-text rounded-lg transition-colors disabled:opacity-40"
          disabled={!value.trim()}
          onClick={() => submit(value)}
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  )
}