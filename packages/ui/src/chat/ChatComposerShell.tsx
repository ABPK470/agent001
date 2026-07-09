import { useEffect, type ReactNode } from "react"
import { CommandConsole } from "./CommandConsolePanel"
import type { CommandConsoleVariant } from "./CommandConsolePanel"
import type { CommandConsoleState } from "./useCommandConsole"

export type ComposerDensity = "default" | "hero" | "compact"

/**
 * Cursor-style composer — collapsed by default; expands when the user types
 * `/` (palette) or when a slash command returns structured output (result).
 */
export function ChatComposerShell({
  console: cmdConsole,
  slashPalette,
  variant = "term",
  density = "default",
  children,
}: {
  console: CommandConsoleState
  slashPalette: ReactNode | null
  variant?: CommandConsoleVariant
  density?: ComposerDensity
  children: ReactNode
}) {
  const showResult =
    !slashPalette && cmdConsole.pinnedOpen && cmdConsole.lines.length > 0
  const expanded = slashPalette != null || showResult

  const paletteOpen = slashPalette != null

  useEffect(() => {
    if (paletteOpen) cmdConsole.clear()
  }, [paletteOpen, cmdConsole.clear])

  return (
    <div
      className={[
        "chat-composer",
        `chat-composer--${density}`,
        expanded ? "chat-composer--expanded" : "",
      ].join(" ")}
    >
      {expanded ? (
        <div
          className="chat-composer__expand"
          data-pane={slashPalette ? "slash" : "result"}
        >
          {slashPalette ?? (
            <CommandConsole lines={cmdConsole.lines} variant={variant} inline />
          )}
        </div>
      ) : null}
      <div className="chat-composer__body">{children}</div>
    </div>
  )
}
