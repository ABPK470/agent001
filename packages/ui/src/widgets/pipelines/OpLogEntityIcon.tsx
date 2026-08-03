import type { LucideIcon } from "lucide-react"

export function OpLogEntityIcon({
  icon: Icon,
  color,
}: {
  icon: LucideIcon
  color?: string
}) {
  return (
    <span className="op-log-entity-icon" aria-hidden>
      <Icon size={14} strokeWidth={1.75} className="op-log-entity-icon__glyph" style={color ? { color } : undefined} />
    </span>
  )
}
