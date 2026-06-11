import { ArrowDown } from "lucide-react"

/** Matches TermChatInputBar send control — icon-only scroll-to-bottom affordance. */
export function ScrollToLatestButton({
  onClick,
  className = "",
}: {
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Scroll to latest output"
      title="Latest output"
      className={`flex items-center justify-center w-10 h-10 rounded-xl bg-panel/72 backdrop-blur border border-border-subtle text-text-muted hover:text-text hover:bg-panel/72 transition-colors ${className}`}
    >
      <ArrowDown size={18} />
    </button>
  )
}
