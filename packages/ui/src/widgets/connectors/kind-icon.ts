/** Connectors chrome — `Cable` for modal shell and session menu; instances use `ConnectorKindMark`. */

import { Cable, type LucideIcon } from "lucide-react"

export const CONNECTOR_ICON: LucideIcon = Cable

/** Instance / menu glyph — not per-kind. */
export function connectorInstanceIcon(): LucideIcon {
  return CONNECTOR_ICON
}
