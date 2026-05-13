/**
 * Command registry — single source of truth for every action the user can
 * invoke in the term UI.
 *
 * One definition serves four surfaces:
 *   1. CommandPalette  (Ctrl+K / ?)        — fuzzy-filterable menu
 *   2. Slash dispatcher (typed in prompt)  — `/cancel`, `/runs`, …
 *   3. Global keybinds (handleKey)         — `Ctrl+1`, `Ctrl+.`, …
 *   4. HelpBar footer hints                — only items marked `pinned`
 *
 * Adding a new action means appending one entry here. The shell wires
 * itself up automatically.
 */

import { META_LABEL } from "./keybinds"

export type CommandGroup = "navigate" | "run" | "log" | "shell"

export interface CommandContext {
  /** True when an active run is currently running or pending. */
  busy: boolean
  /** Currently focused run id, if any. */
  activeRunId: string | null
  /** Are we currently being asked a question by the agent? */
  hasPendingInput: boolean
}

export interface Command {
  id: string
  label: string
  hint?: string
  group: CommandGroup
  /** Keybind label as shown to the user, e.g. "Ctrl+R". */
  keybind?: string
  /** Slash form typed in the prompt (lowercase, no leading "/"). Aliases supported via `slashAliases`. */
  slash?: string
  slashAliases?: string[]
  /** Surface in the slim HelpBar at the bottom. Keep ≤ 5. */
  pinned?: boolean
  /** Hide / disable when this returns false. */
  when?: (ctx: CommandContext) => boolean
  /** Action — invoked from any surface. May be async. */
  run: () => void | Promise<void>
}

/**
 * Build the command list. Wired in App.tsx with closures over its handlers
 * so each command captures the current state.
 */
export function buildCommands(deps: {
  ctx: CommandContext
  openPalette: () => void
  openRunPicker: () => void
  openAdmin: () => void
  focusStream: () => void
  focusLog: () => void
  focusFilter: () => void
  focusPrompt: () => void
  clearFilter: () => void
  abortRun: () => void
  rerunRun: () => Promise<void>
  rollbackRun: () => Promise<void>
  exportTrace: () => Promise<void>
  flagAnswer: () => Promise<void>
  followLog: () => void
  jumpToBottom: () => void
  switchUser: () => void
  switchUi: () => void
  toggleView: () => void
  openAttach: () => void
}): Command[] {
  const { ctx } = deps
  const all: Command[] = [
    // ── NAVIGATE ──────────────────────────────────────────────
    {
      id: "focus.stream",
      label: "Focus stream pane",
      group: "navigate",
      keybind: `${META_LABEL}+1`,
      slash: "stream", slashAliases: ["s"],
      run: deps.focusStream,
    },
    {
      id: "focus.log",
      label: "Focus operations log",
      group: "navigate",
      keybind: `${META_LABEL}+2`,
      slash: "logs", slashAliases: ["l"],
      run: deps.focusLog,
    },
    {
      id: "focus.prompt",
      label: "Focus prompt",
      group: "navigate",
      keybind: `${META_LABEL}+I`,
      run: deps.focusPrompt,
    },
    {
      id: "focus.filter",
      label: "Focus log filter",
      group: "navigate",
      keybind: `${META_LABEL}+F`,
      run: deps.focusFilter,
    },
    {
      id: "filter.clear",
      label: "Clear log filter",
      group: "log",
      keybind: `${META_LABEL}+L`,
      run: deps.clearFilter,
    },
    {
      id: "log.follow",
      label: "Toggle follow active run",
      hint: "show only current run events",
      group: "log",
      keybind: `${META_LABEL}+G`,
      slash: "follow",
      run: deps.followLog,
    },
    {
      id: "log.bottom",
      label: "Jump to bottom",
      hint: "scroll to newest output",
      group: "log",
      keybind: `${META_LABEL}+End`,
      slash: "bottom",
      run: deps.jumpToBottom,
    },

    // ── RUN ───────────────────────────────────────────────────
    {
      id: "runs.picker",
      label: "Open run picker",
      hint: "list & switch runs",
      group: "run",
      keybind: `${META_LABEL}+R`,
      slash: "runs", slashAliases: ["r"],
      run: deps.openRunPicker,
    },
    {
      id: "run.abort",
      label: "Abort active run",
      hint: "send cancel signal",
      group: "run",
      keybind: `${META_LABEL}+.`,
      slash: "cancel", slashAliases: ["c", "abort"],
      pinned: true,
      when: (c) => c.busy,
      run: deps.abortRun,
    },
    {
      id: "run.rerun",
      label: "Re-run with same goal",
      group: "run",
      slash: "rerun",
      when: (c) => !!c.activeRunId,
      run: deps.rerunRun,
    },
    {
      id: "run.rollback",
      label: "Roll back run effects",
      hint: "revert filesystem & db writes",
      group: "run",
      slash: "rollback",
      when: (c) => !!c.activeRunId && !c.busy,
      run: deps.rollbackRun,
    },
    {
      id: "run.export",
      label: "Download trace as .txt",
      hint: "save agent-loop trace to file",
      group: "run",
      keybind: `${META_LABEL}+E`,
      slash: "export", slashAliases: ["download", "trace"],
      when: (c) => !!c.activeRunId,
      run: deps.exportTrace,
    },
    {
      id: "run.flag",
      label: "Flag answer as unhelpful",
      hint: "down-weight memory so agent avoids this approach next time",
      group: "run",
      slash: "flag", slashAliases: ["bad", "wrong"],
      when: (c) => !!c.activeRunId,
      run: deps.flagAnswer,
    },

    // ── SHELL ─────────────────────────────────────────────────
    {
      id: "shell.attach",
      label: "Attach a file to the next run",
      hint: "upload to the durable attachment store",
      group: "shell",
      slash: "attach", slashAliases: ["upload", "file"],
      run: deps.openAttach,
    },
    {
      id: "shell.admin",
      label: "Sign in as admin",
      group: "shell",
      slash: "admin", slashAliases: ["a"],
      run: deps.openAdmin,
    },
    {
      id: "shell.switchUser",
      label: "Switch identity / sign out",
      group: "shell",
      slash: "quit", slashAliases: ["q"],
      run: deps.switchUser,
    },
    {
      id: "shell.switchUi",
      label: "Switch to classic UI",
      group: "shell",
      slash: "ui",
      run: deps.switchUi,
    },
    {
      id: "shell.toggleView",
      label: "Toggle visual / TUI mode",
      hint: "calm pipeline view vs log view",
      group: "shell",
      keybind: `${META_LABEL}+\\`,
      slash: "visual", slashAliases: ["vis", "view"],
      run: deps.toggleView,
    },
    {
      id: "shell.palette",
      label: "Show this menu",
      hint: "command palette",
      group: "shell",
      keybind: `${META_LABEL}+K`,
      pinned: true,
      run: deps.openPalette,
    },
  ]
  return all.filter((cmd) => !cmd.when || cmd.when(ctx))
}

/**
 * Try to interpret `text` as a slash command. Returns the matched command
 * or null. Match is case-insensitive on the trimmed input.
 */
export function matchSlash(text: string, commands: Command[]): Command | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith("/")) return null
  const tail = trimmed.slice(1).toLowerCase()
  for (const cmd of commands) {
    if (cmd.slash === tail) return cmd
    if (cmd.slashAliases?.includes(tail)) return cmd
  }
  return null
}

/**
 * Slash autocomplete suggestions for the goal input.
 *
 * Input is the raw textarea contents. We only suggest when the user has
 * started a slash on the FIRST line — slashes mid-prose (e.g. paths) shouldn't
 * trigger the popup. Empty query (just "/") returns every slash command.
 *
 * Matching: prefix match on slash + slashAliases (case-insensitive). Prefix
 * matches rank above substring matches; aliases rank below their canonical
 * slash. Pinned commands win ties.
 */
export interface SlashSuggestion {
  slash: string         // canonical slash, no leading "/"
  alias?: string        // matched alias, if user typed an alias prefix
  label: string
  hint?: string
  keybind?: string
  group: CommandGroup
  run: () => void | Promise<void>
}

export function slashSuggestions(text: string, commands: Command[]): SlashSuggestion[] {
  // Only the first line — paste-multiline is fine, we just don't auto-complete
  // when the slash isn't the very first thing typed.
  const firstLine = text.split("\n")[0] ?? ""
  if (!firstLine.startsWith("/")) return []
  const query = firstLine.slice(1).toLowerCase().trim()

  type Scored = { sug: SlashSuggestion; score: number }
  const out: Scored[] = []

  for (const cmd of commands) {
    if (!cmd.slash) continue
    const candidates: { token: string; isAlias: boolean }[] = [{ token: cmd.slash, isAlias: false }]
    for (const a of cmd.slashAliases ?? []) candidates.push({ token: a, isAlias: true })

    let best = -1
    let bestAlias: string | undefined
    for (const { token, isAlias } of candidates) {
      let score = 0
      if (!query) score = 50                                      // empty query → list everything
      else if (token === query) score = 100                       // exact
      else if (token.startsWith(query)) score = 80 - token.length // prefix; shorter token wins
      else if (token.includes(query)) score = 40                  // substring (low)
      if (isAlias) score -= 5                                      // canonical wins ties
      if (score > best) { best = score; bestAlias = isAlias ? token : undefined }
    }

    if (best <= 0) continue
    if (cmd.pinned) best += 1
    out.push({
      sug: {
        slash: cmd.slash,
        alias: bestAlias,
        label: cmd.label,
        hint: cmd.hint,
        keybind: cmd.keybind,
        group: cmd.group,
        run: cmd.run,
      },
      score: best,
    })
  }

  out.sort((a, b) => b.score - a.score)
  return out.map((s) => s.sug)
}

/** Cheap fuzzy score: substring + initials. Higher = better. 0 = no match. */
export function fuzzyScore(query: string, label: string): number {
  if (!query) return 1
  const q = query.toLowerCase()
  const l = label.toLowerCase()
  if (l === q) return 100
  if (l.startsWith(q)) return 80
  if (l.includes(q)) return 60
  // Initials match: "fs" → "Focus stream"
  const initials = l.split(/[\s/-]+/).map((w) => w[0]).join("")
  if (initials.startsWith(q)) return 50
  // Subsequence
  let i = 0
  for (const ch of l) { if (ch === q[i]) i++; if (i === q.length) return 30 }
  return 0
}
