import type { ChatSlashCatalogEntry } from "./commands"

export type CommandLineKind =
  | "input"
  | "text"
  | "success"
  | "error"
  | "help"
  | "rows"
  | "list"

export interface CommandConsoleLine {
  id: string
  kind: CommandLineKind
  input?: string
  text?: string
  help?: Array<{
    slash: string
    label: string
    hint?: string
    available?: boolean
    unavailableReason?: string
  }>
  rows?: Array<{ label: string; value: string }>
  list?: Array<{ primary: string; secondary?: string; marker?: string }>
}

export interface CommandConsoleApi {
  logInput: (input: string) => void
  logText: (text: string) => void
  logSuccess: (text: string) => void
  logError: (text: string) => void
  logHelp: (commands: readonly ChatSlashCatalogEntry[]) => void
  logRows: (rows: Array<{ label: string; value: string }>) => void
  logList: (items: Array<{ primary: string; secondary?: string; marker?: string }>) => void
  open: () => void
  beginBatch: () => void
  endBatch: () => void
}

export function helpEntriesFromCommands(
  commands: readonly ChatSlashCatalogEntry[],
): CommandConsoleLine["help"] {
  return commands.map((cmd) => ({
    slash: cmd.slash,
    label: cmd.label,
    hint: cmd.hint,
    available: cmd.available,
    unavailableReason: cmd.unavailableReason,
  }))
}
