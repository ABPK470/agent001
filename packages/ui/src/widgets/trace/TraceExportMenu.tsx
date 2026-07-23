/**
 * Trace toolbar download menu — same export paths as `/trace` slash commands.
 * Lives inside the Expanded/Collapsed segment track (group chrome).
 */

import { Download, FileJson, FileText } from "lucide-react"
import { useState, type JSX } from "react"
import { threadExportFilename, traceExportFilename } from "@mia/shared-types"
import { downloadAuthenticated } from "../../lib/userDownload"
import { ToolbarMenu, ToolbarMenuItem } from "../entity-registry/ToolbarMenu"
import { ToolbarTrackDivider } from "../entity-registry/ToolbarTrack"

export type TraceExportTarget =
  | { kind: "run"; runId: string }
  | { kind: "thread"; threadId: string }

export interface TraceExportMenuProps {
  target: TraceExportTarget | null
  onExported?: (message: string) => void
  onError?: (message: string) => void
}

async function exportTrace(
  target: TraceExportTarget,
  format: "txt" | "json",
  omitCode: boolean,
): Promise<{ filename: string; bytes: number }> {
  const qs = omitCode ? "?omitCode=1" : ""
  if (target.kind === "run") {
    const path =
      format === "json"
        ? `/api/runs/${encodeURIComponent(target.runId)}/export/trace.json${qs}`
        : `/api/runs/${encodeURIComponent(target.runId)}/export/trace${qs}`
    return downloadAuthenticated(
      path,
      traceExportFilename(target.runId, format, { omitCode }),
    )
  }
  const path =
    format === "json"
      ? `/api/threads/${encodeURIComponent(target.threadId)}/export/trace.json${qs}`
      : `/api/threads/${encodeURIComponent(target.threadId)}/export/trace${qs}`
  return downloadAuthenticated(
    path,
    threadExportFilename(target.threadId, format, { omitCode }),
  )
}

export function TraceExportMenu({
  target,
  onExported,
  onError,
}: TraceExportMenuProps): JSX.Element | null {
  const [busy, setBusy] = useState(false)
  if (!target) return null

  async function run(format: "txt" | "json", omitCode: boolean): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const { filename, bytes } = await exportTrace(target, format, omitCode)
      onExported?.(`Exported ${filename} (${bytes.toLocaleString()} bytes)`)
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Export failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <ToolbarTrackDivider />
      <ToolbarMenu
        title="Download trace"
        ariaLabel="Download trace"
        trigger={<Download size={15} strokeWidth={1.75} />}
        minWidthClass="min-w-[14rem]"
        variant="group"
      >
        <ToolbarMenuItem
          icon={<FileText size={14} />}
          label="Text (.txt)"
          onClick={() => void run("txt", false)}
          disabled={busy}
        />
        <ToolbarMenuItem
          icon={<FileJson size={14} />}
          label="JSON (.json)"
          onClick={() => void run("json", false)}
          disabled={busy}
        />
        <div className="my-1 border-t border-border-subtle" role="separator" />
        <ToolbarMenuItem
          icon={<FileText size={14} />}
          label="Text · no code"
          onClick={() => void run("txt", true)}
          disabled={busy}
        />
        <ToolbarMenuItem
          icon={<FileJson size={14} />}
          label="JSON · no code"
          onClick={() => void run("json", true)}
          disabled={busy}
        />
      </ToolbarMenu>
    </>
  )
}
