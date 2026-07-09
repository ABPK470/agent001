import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react"
import type { ChatSlashCatalogEntry } from "./commands"
import { SlashCommandPalette } from "./SlashCommandPalette"
import type { SlashPaletteVariant } from "./SlashCommandPalette"
import {
  autofillSlashCommand,
  filterSlashCommands,
  nextSelectableSlashIndex,
  slashCommandQuery,
  slashPaletteVisible,
} from "./slashPaletteUtils"

export function useSlashCommandInput({
  value,
  onChange,
  commands,
  disabled = false,
  variant = "term",
  onCollapse,
  hasResult = false,
}: {
  value: string
  onChange: (value: string) => void
  commands: readonly ChatSlashCatalogEntry[]
  disabled?: boolean
  variant?: SlashPaletteVariant
  onCollapse?: () => void
  hasResult?: boolean
}) {
  const query = slashCommandQuery(value)
  const open = slashPaletteVisible(value, disabled)
  const filtered = useMemo(
    () => filterSlashCommands(commands, query),
    [commands, query],
  )
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    setActiveIndex(nextSelectableSlashIndex(filtered, -1, 1))
  }, [query, filtered])

  const acceptCommand = useCallback(
    (cmd: ChatSlashCatalogEntry) => {
      if (!cmd.available) return
      onChange(autofillSlashCommand(cmd))
      setActiveIndex(0)
    },
    [onChange],
  )

  const acceptHighlighted = useCallback(() => {
    const cmd = filtered[activeIndex]
    if (cmd?.available) acceptCommand(cmd)
  }, [filtered, activeIndex, acceptCommand])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>): boolean => {
      if (e.key === "Escape") {
        e.preventDefault()
        onCollapse?.()
        return true
      }

      if (!open) return false

      if (e.key === "Tab") {
        e.preventDefault()
        acceptHighlighted()
        return true
      }

      if (e.key === "Enter" && !e.shiftKey) {
        const cmd = filtered[activeIndex]
        if (!cmd?.available) {
          e.preventDefault()
          return true
        }
        const trimmed = value.trimStart()
        const complete = `/${cmd.slash}`
        // Already autocompleted — let Enter submit/run the command.
        if (trimmed === complete || trimmed.startsWith(`${complete} `)) {
          return false
        }
        e.preventDefault()
        acceptHighlighted()
        return true
      }

      if (e.key === "ArrowDown" && filtered.length > 0) {
        e.preventDefault()
        setActiveIndex((i) => nextSelectableSlashIndex(filtered, i, 1))
        return true
      }

      if (e.key === "ArrowUp" && filtered.length > 0) {
        e.preventDefault()
        setActiveIndex((i) => nextSelectableSlashIndex(filtered, i, -1))
        return true
      }

      return false
    },
    [open, filtered, activeIndex, acceptHighlighted, onCollapse, value],
  )

  const palette =
    open ? (
      <SlashCommandPalette
        commands={filtered}
        query={query ?? ""}
        activeIndex={Math.min(activeIndex, Math.max(0, filtered.length - 1))}
        onSelect={acceptCommand}
        onHover={setActiveIndex}
        variant={variant}
        inline
      />
    ) : null

  return {
    palette,
    handleKeyDown,
    paletteOpen: open,
    composerExpanded: open || hasResult,
  }
}
