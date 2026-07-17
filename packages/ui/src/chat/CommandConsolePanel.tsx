import { useEffect, useRef } from "react"
import { ComposerCommandRow } from "./ComposerCommandRow"
import { COMPOSER_RESULT_HINTS, ComposerKbdFooter } from "./ComposerKbdFooter"
import type { CommandConsoleLine } from "./commandConsoleModel"

export type CommandConsoleVariant = "term"

export function CommandConsole({
  lines,
  variant = "term",
  inline = false,
}: {
  lines: CommandConsoleLine[]
  onDismiss?: () => void
  onClear?: () => void
  variant?: CommandConsoleVariant
  inline?: boolean
}) {
  const tailRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    tailRef.current?.scrollIntoView({ block: "nearest" })
  }, [lines.length])

  if (lines.length === 0) return null

  const rootClass = [
    "cmd-console",
    inline ? "cmd-console--inline" : "",
  ]
    .filter(Boolean)
    .join(" ")

  return (
    <div className={rootClass} role="status" aria-live="polite">
      <div className="cmd-console__scroll">
        {lines.map((line) => (
          <CommandConsoleBlock key={line.id} line={line} />
        ))}
        <div ref={tailRef} />
      </div>
      {inline ? <ComposerKbdFooter hints={[...COMPOSER_RESULT_HINTS]} /> : null}
    </div>
  )
}

function CommandConsoleBlock({ line }: { line: CommandConsoleLine }) {
  if (line.kind === "success" || line.kind === "error" || line.kind === "text") {
    const text = line.text
    if (!text) return null
    return (
      <p className={`cmd-console__message cmd-console__message--${line.kind}`}>
        {text}
      </p>
    )
  }

  if (line.kind === "help" && line.help) {
    return (
      <div className="cmd-console__section" role="list">
        <p className="cmd-console__section-title">Slash commands</p>
        {line.help.map((cmd) => (
          <ComposerCommandRow
            key={cmd.slash}
            name={`/${cmd.slash}`}
            description={cmd.label}
            meta={cmd.hint}
            disabled={cmd.available === false}
            unavailableNote={cmd.unavailableReason}
          />
        ))}
      </div>
    )
  }

  if (line.kind === "rows" && line.rows) {
    return (
      <div className="cmd-console__section">
        <p className="cmd-console__section-title">Status</p>
        <dl className="cmd-console__facts">
          {line.rows.map((row) => (
            <div key={`${row.label}-${row.value}`} className="cmd-console__fact">
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    )
  }

  if (line.kind === "list" && line.list) {
    return (
      <div className="cmd-console__section">
        <p className="cmd-console__section-title">Results</p>
        <div className="cmd-console__items">
          {line.list.map((item) => (
            <div key={item.primary} className="cmd-console__item">
              {item.marker ? <span className="cmd-console__item-marker">{item.marker}</span> : null}
              <span className="cmd-console__item-primary">{item.primary}</span>
              {item.secondary ? (
                <span className="cmd-console__item-secondary">{item.secondary}</span>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    )
  }

  return null
}
