/**
 * Cursor-style composer — input stays fixed height; slash palette floats above
 * the chrome pill (rendered by the parent wrapper, not inside this shell).
 * Expands only when a slash command returns structured output (result console).
 */

import { useEffect, type ReactNode } from "react"
import { CommandConsole } from "./CommandConsolePanel"
import type { CommandConsoleVariant } from "./CommandConsolePanel"
import type { CommandConsoleState } from "./useCommandConsole"

export type ComposerDensity = "default" | "hero" | "compact"

export function ChatComposerShell({
  console: cmdConsole,
  paletteOpen = false,
  variant = "term",
  density = "default",
  children,
}: {
  console: CommandConsoleState
  paletteOpen?: boolean
  variant?: CommandConsoleVariant
  density?: ComposerDensity
  children: ReactNode
}) {
  const showResult =
    !paletteOpen && cmdConsole.pinnedOpen && cmdConsole.lines.length > 0
  const expanded = showResult

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
        <div className="chat-composer__expand" data-pane="result">
          <CommandConsole lines={cmdConsole.lines} variant={variant} inline />
        </div>
      ) : null}
      <div className="chat-composer__body">{children}</div>
    </div>
  )
}
