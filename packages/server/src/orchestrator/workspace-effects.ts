import type { Tool } from "@agent001/agent"
import { setBasePath, setBrowserCheckCwd, setSearchBasePath, setShellCwd } from "@agent001/agent"
import { recordEffect, recordFileWrite } from "../effects.js"
import type { RunWorkspaceContext, WorkspaceDiff } from "../run-workspace.js"
import { applyWorkspaceDiff, cleanupRunWorkspace, computeWorkspaceDiff } from "../run-workspace.js"
import { broadcast } from "../event-broadcaster.js"
import type { ActiveRun, NotificationOpts } from "./types.js"

// ── Workspace context serialization ───────────────────────────────

/**
 * Serialize tool calls that set workspace globals.
 * All tool.execute calls run sequentially through this queue,
 * so workspace path globals are set/restored atomically.
 */
export async function withToolWorkspaceContext<T>(
  queueRef: { current: Promise<void> },
  workspace: string | null,
  workspaceRoot: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = queueRef.current
  let release!: () => void
  queueRef.current = new Promise<void>((resolve) => { release = resolve })

  await previous
  setBasePath(workspaceRoot)
  setSearchBasePath(workspaceRoot)
  setShellCwd(workspaceRoot)
  setBrowserCheckCwd(workspaceRoot)

  try {
    return await fn()
  } finally {
    setBasePath(workspace ?? process.cwd())
    setSearchBasePath(workspace ?? process.cwd())
    setShellCwd(workspace ?? process.cwd())
    setBrowserCheckCwd(workspace ?? process.cwd())
    release()
  }
}

// ── Effect-tracked tool wrappers ──────────────────────────────────

/**
 * Wrap a tool with effect tracking.
 * - write_file: captures pre-write snapshot + records file effect
 * - run_command: records command effect after execution
 * - all others: run inside the workspace context serializer
 */
export function wrapWithEffects(
  tool: Tool,
  runId: string,
  workspaceRoot: string,
  withCtx: <T>(workspaceRoot: string, fn: () => Promise<T>) => Promise<T>,
): Tool {
  if (tool.name === "write_file") {
    return {
      ...tool,
      execute: async (args) => withCtx(workspaceRoot, async () => {
        const { resolve } = await import("node:path")
        const absPath = resolve(workspaceRoot, String(args.path))
        await recordFileWrite({ runId, tool: "write_file", filePath: absPath, newContent: String(args.content) })
        return tool.execute(args)
      }),
    }
  }

  if (tool.name === "run_command") {
    return {
      ...tool,
      execute: async (args) => withCtx(workspaceRoot, async () => {
        const result = await tool.execute(args)
        recordEffect({ runId, kind: "command", tool: "run_command", target: String(args.command ?? args.cmd ?? ""), metadata: { output: String(result).slice(0, 1000) } })
        return result
      }),
    }
  }

  return {
    ...tool,
    execute: async (args) => withCtx(workspaceRoot, () => tool.execute(args)),
  }
}

// ── Run workspace diff ─────────────────────────────────────────────

export async function captureRunWorkspaceDiff(
  runId: string,
  activeRuns: Map<string, ActiveRun>,
  completedRunWorkspaces: Map<string, RunWorkspaceContext>,
  completedRunDiffs: Map<string, WorkspaceDiff>,
  saveTrace: (runId: string, entry: Record<string, unknown>) => void,
  createNotification: (opts: NotificationOpts) => void,
): Promise<void> {
  const run = activeRuns.get(runId)
  if (!run?.workspace?.isolated) return

  const diff = await computeWorkspaceDiff(run.workspace.sourceRoot, run.workspace.executionRoot)
  completedRunWorkspaces.set(runId, run.workspace)
  completedRunDiffs.set(runId, diff)

  const total = diff.added.length + diff.modified.length + diff.deleted.length
  if (total === 0) {
    await cleanupRunWorkspace(run.workspace)
    completedRunWorkspaces.delete(runId)
    completedRunDiffs.delete(runId)
    return
  }

  saveTrace(runId, { kind: "workspace_diff", diff })
  broadcast({ type: "debug.trace", data: { runId, seq: Date.now(), entry: { kind: "workspace_diff", diff } } })
  createNotification({
    type: "run.completed",
    title: "Apply run changes",
    message: `Run ${runId.slice(0, 8)} produced ${total} isolated workspace changes pending approval.`,
    runId,
    actions: [
      { label: "Review", action: "view-run", data: { runId } },
      { label: "Apply", action: "apply-run-diff", data: { runId } },
    ],
  })
}

export async function applyRunWorkspaceDiff(
  runId: string,
  completedRunWorkspaces: Map<string, RunWorkspaceContext>,
  completedRunDiffs: Map<string, WorkspaceDiff>,
  saveTrace: (runId: string, entry: Record<string, unknown>) => void,
  createNotification: (opts: NotificationOpts) => void,
): Promise<{ added: number; modified: number; deleted: number } | null> {
  const context = completedRunWorkspaces.get(runId)
  const diff = completedRunDiffs.get(runId)
  if (!context || !diff) return null

  const summary = await applyWorkspaceDiff({
    sourceRoot: context.sourceRoot,
    executionRoot: context.executionRoot,
    diff,
  })
  await cleanupRunWorkspace(context)
  completedRunWorkspaces.delete(runId)
  completedRunDiffs.delete(runId)

  saveTrace(runId, { kind: "workspace_diff_applied", summary })
  broadcast({ type: "debug.trace", data: { runId, seq: Date.now(), entry: { kind: "workspace_diff_applied", summary } } })
  createNotification({
    type: "run.completed",
    title: "Run changes applied",
    message: `Applied ${summary.added + summary.modified + summary.deleted} file changes from isolated run ${runId.slice(0, 8)}.`,
    runId,
    actions: [{ label: "View", action: "view-run", data: { runId } }],
  })

  return summary
}
