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
      className={`flex items-center justify-center w-10 h-10 rounded-xl bg-elevated dark:bg-overlay-2 border border-border ring-1 ring-overlay-1 text-text-muted hover:text-text hover:bg-overlay-hover transition-colors shadow-sm ${className}`}
    >
      <ArrowDown size={18} />
    </button>
  )
}
