import { useEffect, useRef } from "react"
import type { ChatSlashCatalogEntry } from "./commands"
import { ComposerCommandRow } from "./ComposerCommandRow"
import { COMPOSER_PALETTE_HINTS, ComposerKbdFooter } from "./ComposerKbdFooter"

export type SlashPaletteVariant = "term" | "ioe"

export function SlashCommandPalette({
  commands,
  query,
  activeIndex,
  onSelect,
  onHover,
  variant = "term",
  inline = false,
}: {
  commands: ChatSlashCatalogEntry[]
  query: string
  activeIndex: number
  onSelect: (cmd: ChatSlashCatalogEntry) => void
  onHover: (index: number) => void
  variant?: SlashPaletteVariant
  inline?: boolean
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" })
  }, [activeIndex])

  const rootClass = [
    "slash-palette",
    variant === "ioe" ? "slash-palette--ioe" : "",
    inline ? "slash-palette--inline" : "",
  ]
    .filter(Boolean)
    .join(" ")

  const selectable = commands.filter((cmd) => cmd.available)
  const activeCommand = commands[activeIndex]

  if (commands.length === 0) {
    return (
      <div className={rootClass} role="listbox" aria-label="Slash commands">
        <div className="slash-palette__empty">No matching commands</div>
        <ComposerKbdFooter hints={[...COMPOSER_PALETTE_HINTS]} />
      </div>
    )
  }

  return (
    <div
      className={rootClass}
      role="listbox"
      aria-label="Slash commands"
      aria-activedescendant={activeCommand ? `slash-cmd-${activeCommand.id}` : undefined}
    >
      <p className="slash-palette__title">Commands</p>
      <div ref={listRef} className="slash-palette__list">
        {commands.map((cmd, index) => {
          const active = index === activeIndex
          return (
            <ComposerCommandRow
              key={cmd.id}
              id={`slash-cmd-${cmd.id}`}
              optionRef={active ? activeRef : undefined}
              interactive
              active={active}
              disabled={!cmd.available}
              unavailableNote={cmd.unavailableReason}
              name={<>/<SlashHighlight slash={cmd.slash} query={query} /></>}
              description={cmd.label}
              meta={cmd.hint}
              onSelect={() => onSelect(cmd)}
              onHover={() => onHover(index)}
            />
          )
        })}
      </div>
      {selectable.length === 0 ? (
        <p className="slash-palette__notice">No commands available in the current context.</p>
      ) : null}
      <ComposerKbdFooter hints={[...COMPOSER_PALETTE_HINTS]} />
    </div>
  )
}

function SlashHighlight({ slash, query }: { slash: string; query: string }) {
  if (!query) return <>{slash}</>
  const matchLen = slash.toLowerCase().startsWith(query) ? query.length : 0
  if (matchLen === 0) return <>{slash}</>
  return (
    <>
      <span className="composer-cmd-row__match">{slash.slice(0, matchLen)}</span>
      <span>{slash.slice(matchLen)}</span>
    </>
  )
}
