import { ArrowDown } from "lucide-react"

export function ScrollToLatestButton({
  onClick,
  label = "Latest",
  className = "",
}: {
  onClick: () => void
  label?: string
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium text-accent bg-panel-2 border border-accent/30 shadow-md hover:bg-panel-2 hover:border-accent/50 transition-colors ${className}`}
      aria-label="Scroll to latest output"
    >
      <ArrowDown size={13} />
      {label}
    </button>
  )
}
