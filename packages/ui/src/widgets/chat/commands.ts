/**
 * Chat slash commands — shared by TermChat, AgentChat, and IOE goal input.
 *
 * Exact command names only (no aliases). Every export streams to the user's
 * browser; the server never writes export files for delivery.
 */

export type TraceExportFormat = "txt" | "json"

export interface ChatCommandContext {
  busy: boolean
  activeThreadId: string | null
  lastRunId: string | null
  hasPendingInput: boolean
}

export interface ChatSlashCommand {
  id: string
  label: string
  hint?: string
  slash: string
  when?: (ctx: ChatCommandContext) => boolean
  run: (args: string) => void | Promise<void>
}

export interface ParsedSlash {
  command: string
  args: string
}

export function parseSlashInput(text: string): ParsedSlash | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith("/")) return null
  const rest = trimmed.slice(1)
  const space = rest.search(/\s/)
  if (space === -1) return { command: rest.toLowerCase(), args: "" }
  return {
    command: rest.slice(0, space).toLowerCase(),
    args: rest.slice(space).trim(),
  }
}

/** Longest slash first so `/trace-thread` wins over `/trace`. */
export function matchChatSlash(
  text: string,
  commands: ChatSlashCommand[],
): ChatSlashCommand | null {
  const parsed = parseSlashInput(text)
  if (!parsed) return null
  const sorted = [...commands].sort((a, b) => b.slash.length - a.slash.length)
  for (const cmd of sorted) {
    if (parsed.command === cmd.slash) return cmd
  }
  return null
}

export function parseTraceExportFormat(args: string): TraceExportFormat {
  const lower = args.toLowerCase()
  if (lower.includes("--json")) return "json"
  if (lower.includes("--txt")) return "txt"
  return "txt"
}

/** While a run is active, goal input accepts only slash commands. */
export function coerceSlashOnlyInput(next: string, prev: string, busy: boolean): string {
  if (!busy) return next
  if (next === "" || next.startsWith("/")) return next
  return prev
}

export interface ChatSlashCatalogEntry extends ChatSlashCommand {
  available: boolean
  unavailableReason?: string
}

function unavailableReasonFor(cmd: ChatSlashCommand): string {
  switch (cmd.id) {
    case "trace":
    case "files":
    case "rerun":
    case "resume":
      return "Requires a run in this thread"
    case "cancel":
      return "No active run"
    case "trace-thread":
      return "Requires an active thread"
    case "status":
      return "Requires a thread or run"
    case "thread":
    case "attach":
      return "Unavailable while a run is active"
    default:
      return "Not available right now"
  }
}

function defineChatSlashCommands(deps: {
  downloadLastRunTrace: (format: TraceExportFormat) => Promise<void>
  downloadThreadTrace: (format: TraceExportFormat) => Promise<void>
  listArtifacts: () => Promise<void>
  cancelRun: () => Promise<void>
  rerunRun: () => Promise<void>
  resumeRun: () => Promise<void>
  showStatus: () => void
  createThread: () => Promise<void>
  openThreads: () => void
  openAttach: () => void
}): ChatSlashCommand[] {
  return [
    {
      id: "thread",
      label: "Create a new thread",
      slash: "thread",
      when: (c) => !c.busy,
      run: () => deps.createThread(),
    },
    {
      id: "threads",
      label: "List threads and open the threads panel",
      slash: "threads",
      run: () => deps.openThreads(),
    },
    {
      id: "trace-thread",
      label: "Download entire thread trace",
      hint: "--txt or --json",
      slash: "trace-thread",
      when: (c) => !!c.activeThreadId,
      run: (args) => deps.downloadThreadTrace(parseTraceExportFormat(args)),
    },
    {
      id: "trace",
      label: "Download last run trace in this thread",
      hint: "--txt or --json",
      slash: "trace",
      when: (c) => !!c.lastRunId,
      run: (args) => deps.downloadLastRunTrace(parseTraceExportFormat(args)),
    },
    {
      id: "status",
      label: "Show thread and run status",
      slash: "status",
      when: (c) => !!c.activeThreadId || !!c.lastRunId,
      run: () => deps.showStatus(),
    },
    {
      id: "cancel",
      label: "Cancel active run",
      slash: "cancel",
      when: (c) => c.busy,
      run: () => deps.cancelRun(),
    },
    {
      id: "rerun",
      label: "Re-run with same goal",
      slash: "rerun",
      when: (c) => !!c.lastRunId && !c.busy,
      run: () => deps.rerunRun(),
    },
    {
      id: "resume",
      label: "Resume from checkpoint",
      slash: "resume",
      when: (c) => !!c.lastRunId && !c.busy,
      run: () => deps.resumeRun(),
    },
    {
      id: "files",
      label: "List downloadable run files",
      slash: "files",
      when: (c) => !!c.lastRunId && !c.busy,
      run: () => deps.listArtifacts(),
    },
    {
      id: "attach",
      label: "Attach a file to the next run",
      slash: "attach",
      when: (c) => !c.busy,
      run: () => deps.openAttach(),
    },
  ]
}

export function buildChatSlashCatalog(deps: {
  ctx: ChatCommandContext
  downloadLastRunTrace: (format: TraceExportFormat) => Promise<void>
  downloadThreadTrace: (format: TraceExportFormat) => Promise<void>
  listArtifacts: () => Promise<void>
  cancelRun: () => Promise<void>
  rerunRun: () => Promise<void>
  resumeRun: () => Promise<void>
  showStatus: () => void
  createThread: () => Promise<void>
  openThreads: () => void
  openAttach: () => void
}): ChatSlashCatalogEntry[] {
  const { ctx } = deps
  return defineChatSlashCommands(deps).map((cmd) => {
    const available = !cmd.when || cmd.when(ctx)
    return {
      ...cmd,
      available,
      unavailableReason: available ? undefined : unavailableReasonFor(cmd),
    }
  })
}

export function buildChatSlashCommands(deps: Parameters<typeof buildChatSlashCatalog>[0]): ChatSlashCommand[] {
  return buildChatSlashCatalog(deps).filter((cmd) => cmd.available)
}


export async function dispatchChatSlashInput(
  text: string,
  catalog: ChatSlashCatalogEntry[],
): Promise<{ handled: boolean; message?: string; error?: boolean }> {
  if (!text.trim().startsWith("/")) return { handled: false }

  try {
    const parsed = parseSlashInput(text)
    if (!parsed) return { handled: false }

    if (!parsed.command) {
      return { handled: true, message: "Pick a command from the list or keep typing." }
    }

    const sorted = [...catalog].sort((a, b) => b.slash.length - a.slash.length)
    const cmd = sorted.find((c) => c.slash === parsed.command)
    if (!cmd) {
      return { handled: true, message: "Unknown command. Press / to see available commands." }
    }
    if (!cmd.available) {
      return {
        handled: true,
        message: cmd.unavailableReason ?? "This command is not available right now.",
      }
    }
    await cmd.run(parsed.args)
    return { handled: true }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { handled: true, message, error: true }
  }
}
