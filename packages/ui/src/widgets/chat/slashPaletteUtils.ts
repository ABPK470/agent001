import type { ChatSlashCatalogEntry } from "./commands"

/** Command-name fragment after `/` while the user is still typing (no space yet). */
export function slashCommandQuery(value: string): string | null {
  const trimmed = value.trimStart()
  if (!trimmed.startsWith("/")) return null
  const rest = trimmed.slice(1)
  const space = rest.search(/\s/)
  if (space !== -1) return null
  return rest.toLowerCase()
}

export function filterSlashCommands(
  commands: readonly ChatSlashCatalogEntry[],
  query: string | null,
): ChatSlashCatalogEntry[] {
  if (query === null) return []
  if (query === "") return [...commands]
  return commands.filter((cmd) => cmd.slash.startsWith(query))
}

/** Text inserted when the user accepts a suggestion (Tab, Enter, or click). */
export function autofillSlashCommand(cmd: ChatSlashCatalogEntry): string {
  if (cmd.hint) return `/${cmd.slash} `
  return `/${cmd.slash}`
}

/** Split `--txt | --json` style hints into discrete flag tokens for badges. */
export function parseCommandFlags(hint?: string): string[] {
  if (!hint?.trim()) return []
  return hint
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean)
}

export function slashPaletteVisible(value: string, disabled: boolean): boolean {
  return !disabled && slashCommandQuery(value) !== null
}

export function nextSelectableSlashIndex(
  commands: readonly ChatSlashCatalogEntry[],
  current: number,
  direction: 1 | -1,
): number {
  if (commands.length === 0) return 0
  let index = current
  for (let step = 0; step < commands.length; step++) {
    index = (index + direction + commands.length) % commands.length
    if (commands[index]?.available) return index
  }
  return Math.max(0, current)
}
