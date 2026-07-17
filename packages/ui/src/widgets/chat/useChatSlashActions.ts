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
  type TraceExportFormat,
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

  const ctx: ChatCommandContext = useMemo(
    () => ({
      busy:
        runStatus === RunStatus.Running ||
        runStatus === RunStatus.Pending ||
        runStatus === RunStatus.Planning,
      activeThreadId,
      lastRunId,
      hasPendingInput,
    }),
    [activeThreadId, hasPendingInput, lastRunId, runStatus],
  )

  const downloadLastRunTrace = useCallback(
    async (format: TraceExportFormat) => {
      if (!lastRunId) throw new Error("No run in this thread to export")
      const path =
        format === "json"
          ? `/api/runs/${encodeURIComponent(lastRunId)}/export/trace.json`
          : `/api/runs/${encodeURIComponent(lastRunId)}/export/trace`
      const { filename, bytes } = await downloadAuthenticated(
        path,
        traceExportFilename(lastRunId, format),
      )
      consoleRef.current.logSuccess(`Downloaded ${filename} (${bytes.toLocaleString()} bytes)`)
    },
    [lastRunId],
  )

  const downloadThreadTrace = useCallback(
    async (format: TraceExportFormat) => {
      if (!activeThreadId) throw new Error("No active thread")
      const path =
        format === "json"
          ? `/api/threads/${encodeURIComponent(activeThreadId)}/export/trace.json`
          : `/api/threads/${encodeURIComponent(activeThreadId)}/export/trace`
      const { filename, bytes } = await downloadAuthenticated(
        path,
        threadExportFilename(activeThreadId, format),
      )
      consoleRef.current.logSuccess(`Downloaded ${filename} (${bytes.toLocaleString()} bytes)`)
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
      }),
    [
      ctx,
      downloadLastRunTrace,
      downloadThreadTrace,
      lastRunId,
      lastRun,
      onRunStarted,
      openFilePicker,
      threads,
      activeThreadId,
      liveUsage,
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
      } catch {
        /* dispatch may still work for thread-agnostic commands */
      }

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
