import { useCallback, useMemo, useRef } from "react"
import { threadExportFilename, traceExportFilename } from "@mia/shared-types"
import { api } from "../../client/index"
import { downloadAuthenticated } from "../../lib/userDownload"
import { RunStatus } from "../../enums"
import { useStore } from "../../state/store"
import type { Run } from "../../types"
import {
  buildChatSlashCatalog,
  dispatchChatSlashInput,
  type ChatCommandContext,
  type ChatSlashCatalogEntry,
  type TraceExportOptions,
} from "./commands"
import type { CommandConsoleApi } from "./commandConsoleModel"

export function lastRunInThread(runs: Run[], threadId: string | null): Run | null {
  if (!threadId) return null
  let latest: Run | null = null
  for (const run of runs) {
    if (run.threadId !== threadId) continue
    if (!latest || run.createdAt > latest.createdAt) latest = run
  }
  return latest
}

export interface ChatSlashActionsOptions {
  activeThreadId: string | null
  runs: Run[]
  runStatus?: string | null
  hasPendingInput?: boolean
  onRunStarted?: (runId: string) => void
  console: CommandConsoleApi
  openFilePicker?: () => void
  openTableExport?: () => void
}

export function useChatSlashActions(opts: ChatSlashActionsOptions) {
  const {
    activeThreadId,
    runs,
    runStatus,
    hasPendingInput = false,
    onRunStarted,
    console,
    openFilePicker,
    openTableExport,
  } = opts

  const threads = useStore((s) => s.threads)
  const liveUsage = useStore((s) => s.liveUsage)
  const consoleRef = useRef(console)
  consoleRef.current = console

  const lastRun = useMemo(
    () => lastRunInThread(runs, activeThreadId),
    [runs, activeThreadId],
  )
  const lastRunId = lastRun?.id ?? null
  const upsertRun = useStore((s) => s.upsertRun)

  const ctx: ChatCommandContext = useMemo(
    () => ({
      busy:
        runStatus === RunStatus.Running ||
        runStatus === RunStatus.Pending ||
        runStatus === RunStatus.Planning,
      activeThreadId,
      lastRunId,
      lastRunStatus: lastRun?.status ?? null,
      lastRunHasCheckpoint: lastRun?.hasCheckpoint ?? null,
      lastRunRollbackAvailable: lastRun?.rollbackAvailable ?? null,
      hasPendingInput,
    }),
    [
      activeThreadId,
      hasPendingInput,
      lastRun?.hasCheckpoint,
      lastRun?.rollbackAvailable,
      lastRun?.status,
      lastRunId,
      runStatus,
    ],
  )

  const downloadLastRunTrace = useCallback(
    async (options: TraceExportOptions) => {
      if (!lastRunId) throw new Error("No run in this thread to export")
      const qs = options.omitCode ? "?omitCode=1" : ""
      const path =
        options.format === "json"
          ? `/api/runs/${encodeURIComponent(lastRunId)}/export/trace.json${qs}`
          : `/api/runs/${encodeURIComponent(lastRunId)}/export/trace${qs}`
      const { filename, bytes } = await downloadAuthenticated(
        path,
        traceExportFilename(lastRunId, options.format, { omitCode: options.omitCode }),
      )
      consoleRef.current.logSuccess(
        `Exported ${filename} (${bytes.toLocaleString()} bytes)`,
      )
    },
    [lastRunId],
  )

  const downloadThreadTrace = useCallback(
    async (options: TraceExportOptions) => {
      if (!activeThreadId) throw new Error("No active thread")
      const qs = options.omitCode ? "?omitCode=1" : ""
      const path =
        options.format === "json"
          ? `/api/threads/${encodeURIComponent(activeThreadId)}/export/trace.json${qs}`
          : `/api/threads/${encodeURIComponent(activeThreadId)}/export/trace${qs}`
      const { filename, bytes } = await downloadAuthenticated(
        path,
        threadExportFilename(activeThreadId, options.format, { omitCode: options.omitCode }),
      )
      consoleRef.current.logSuccess(
        `Exported ${filename} (${bytes.toLocaleString()} bytes)`,
      )
    },
    [activeThreadId],
  )

  const slashCatalog = useMemo(
    () =>
      buildChatSlashCatalog({
        ctx,
        downloadLastRunTrace,
        downloadThreadTrace,
        listArtifacts: async () => {
          if (!lastRunId) return
          const { files } = await api.listRunArtifacts(lastRunId)
          if (files.length === 0) {
            consoleRef.current.logText("No files in the last run workspace.")
            return
          }
          const items = files.slice(0, 40).map((f) => ({
            primary: f.path,
            secondary: `${f.sizeBytes.toLocaleString()} B`,
          }))
          if (files.length > 40) {
            items.push({
              primary: `… and ${files.length - 40} more`,
              secondary: "",
            })
          }
          consoleRef.current.logList(items)
        },
        cancelRun: async () => {
          if (!lastRunId) return
          await api.cancelRun(lastRunId)
          consoleRef.current.logSuccess("Run cancelled.")
        },
        rerunRun: async () => {
          if (!lastRunId) return
          const { runId } = await api.rerunRun(lastRunId)
          onRunStarted?.(runId)
          consoleRef.current.logSuccess(`Re-running as ${runId.slice(0, 8)}…`)
        },
        resumeRun: async () => {
          if (!lastRunId) return
          const { runId } = await api.resumeRun(lastRunId)
          onRunStarted?.(runId)
          consoleRef.current.logSuccess(`Resumed as ${runId.slice(0, 8)}…`)
        },
        rollbackRun: async () => {
          if (!lastRunId) return
          const result = await api.rollbackRun(lastRunId)
          if (result.failed.length > 0) {
            upsertRun({ id: lastRunId, rollbackAvailable: true })
            consoleRef.current.logError(
              `Rolled back ${result.compensated}, ${result.failed.length} failed`,
            )
            return
          }
          upsertRun({ id: lastRunId, rollbackAvailable: false })
          consoleRef.current.logSuccess(
            result.compensated === 0
              ? "Nothing to roll back."
              : `Rolled back ${result.compensated} effect(s).`,
          )
        },
        showStatus: () => {
          const thread = threads.find((t) => t.id === activeThreadId)
          const rows: Array<{ label: string; value: string }> = []
          if (thread) {
            rows.push({
              label: "Thread",
              value: `${thread.title || "Untitled"} · ${thread.id.slice(0, 8)}…`,
            })
          } else if (activeThreadId) {
            rows.push({ label: "Thread", value: activeThreadId.slice(0, 8) + "…" })
          }
          if (lastRun) {
            rows.push({ label: "Last run", value: `${lastRun.id.slice(0, 8)}… · ${lastRun.status}` })
            if (lastRun.goal) rows.push({ label: "Goal", value: lastRun.goal })
            rows.push({
              label: "Checkpoint",
              value: lastRun.hasCheckpoint == null ? "…" : lastRun.hasCheckpoint ? "available" : "none",
            })
            rows.push({
              label: "Rollback",
              value: lastRun.rollbackAvailable == null
                ? "…"
                : lastRun.rollbackAvailable
                  ? "effects pending"
                  : "nothing to roll back",
            })
            const tokens = ctx.busy ? liveUsage.totalTokens : lastRun.totalTokens
            const calls = ctx.busy ? liveUsage.llmCalls : lastRun.llmCalls
            if (tokens || calls) {
              rows.push({
                label: "Usage",
                value: `${tokens ?? "?"} tokens · ${calls ?? "?"} LLM calls`,
              })
            }
            if (lastRun.pendingWorkspaceChanges) {
              rows.push({
                label: "Workspace",
                value: `${lastRun.pendingWorkspaceChanges} pending change(s)`,
              })
            }
          } else {
            rows.push({ label: "Runs", value: "No runs in this thread yet." })
          }
          consoleRef.current.logRows(rows)
        },
        createThread: async () => {
          const id = await useStore.getState().createNewThread()
          useStore.getState().beginThreadTitleShell(id)
          consoleRef.current.logSuccess(`New thread ${id.slice(0, 8)}…`)
        },
        openThreads: () => {
          useStore.getState().openThreadsPanel()
          if (threads.length === 0) {
            consoleRef.current.logText("No threads yet. Use /thread to create one.")
            return
          }
          const items = threads.slice(0, 30).map((t) => ({
            primary: t.title?.trim() || "Untitled",
            secondary: t.id.slice(0, 8) + "…",
            marker: t.id === activeThreadId ? "●" : undefined,
          }))
          if (threads.length > 30) {
            items.push({ primary: `… and ${threads.length - 30} more`, secondary: "", marker: undefined })
          }
          consoleRef.current.logList(items)
        },
        openAttach: () => openFilePicker?.(),
        openTableExport: () => {
          if (!openTableExport) throw new Error("Table export is not available here")
          openTableExport()
        },
      }),
    [
      ctx,
      downloadLastRunTrace,
      downloadThreadTrace,
      lastRunId,
      lastRun,
      onRunStarted,
      openFilePicker,
      openTableExport,
      threads,
      activeThreadId,
      liveUsage,
      upsertRun,
    ],
  )

  const slashCatalogRef = useRef<ChatSlashCatalogEntry[]>(slashCatalog)
  slashCatalogRef.current = slashCatalog

  const tryDispatchSlash = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed.startsWith("/")) return false

      // Thread list + runs hydrate async after login/restore — wait before dispatch.
      try {
        await useStore.getState().bootstrapThreads()
      } catch (err: unknown) { globalThis.console.error("[mia]", err) }

      const catalog = slashCatalogRef.current
      if (catalog.length === 0) {
        consoleRef.current.logText("Commands are still loading. Try again in a moment.")
        return true
      }

      consoleRef.current.beginBatch()
      const result = await dispatchChatSlashInput(trimmed, catalog)
      if (result.message) {
        if (result.error) consoleRef.current.logError(result.message)
        else consoleRef.current.logText(result.message)
      }
      consoleRef.current.endBatch()
      return result.handled
    },
    [],
  )

  const slashOnlyMode = ctx.busy

  return {
    tryDispatchSlash,
    slashCommands: slashCatalog,
    slashOnlyMode,
    downloadLastRunTrace,
    downloadThreadTrace,
  }
}
