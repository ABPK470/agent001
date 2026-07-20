/**
 * Per-table Export / Copy controls for chat markdown tables.
 * Product verb: Export (CSV / JSON). Copy = clipboard CSV only.
 */

import { Check, Copy, Download } from "lucide-react"
import { useRef, useState, type JSX } from "react"
import {
  copyChatTableCsv,
  exportChatTable,
  type ChatTableExportSource,
} from "../lib/chat-table-export"
import type { TableExportFormat } from "@mia/shared-types"

export interface TableExportActionsProps {
  headers: string[]
  rows: string[][]
  source: ChatTableExportSource
  disabled?: boolean
  /** Visual density — compact for TermChat tables. */
  compact?: boolean
  /**
   * Hide until the parent `group` is hovered / focused.
   * Stays visible while Copy/Export feedback or an error is showing.
   */
  revealOnHover?: boolean
}

type Feedback = "copied" | "exported" | null

export function TableExportActions({
  headers,
  rows,
  source,
  disabled = false,
  compact = false,
  revealOnHover = false,
}: TableExportActionsProps): JSX.Element {
  const [feedback, setFeedback] = useState<Feedback>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function scheduleClearFeedback(): void {
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
    clearTimerRef.current = setTimeout(() => {
      setFeedback(null)
      clearTimerRef.current = null
    }, 1600)
  }

  async function onCopy(): Promise<void> {
    if (disabled || busy || rows.length === 0) return
    setError(null)
    setBusy(true)
    try {
      await copyChatTableCsv(headers, rows)
      setFeedback("copied")
      scheduleClearFeedback()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Copy failed")
    } finally {
      setBusy(false)
    }
  }

  async function onExport(format: TableExportFormat): Promise<void> {
    if (disabled || busy || rows.length === 0) return
    setError(null)
    setBusy(true)
    try {
      await exportChatTable({ source, format, headers, rows })
      setFeedback("exported")
      scheduleClearFeedback()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed")
    } finally {
      setBusy(false)
    }
  }

  const btn =
    compact
      ? "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-text-muted hover:text-text hover:bg-overlay-hover disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
      : "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-sm text-text-muted hover:text-text hover:bg-overlay-2 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"

  const idle = !disabled && !busy
  const pinnedVisible = Boolean(feedback || busy || error)

  return (
    <div
      className={[
        "flex flex-wrap items-center gap-1 min-w-0",
        compact
          ? "rounded-md border border-border-subtle bg-panel/95 px-1 py-0.5 shadow-sm backdrop-blur-sm"
          : "",
        revealOnHover
          ? [
              "transition-opacity duration-150",
              pinnedVisible
                ? "opacity-100"
                : "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto",
            ].join(" ")
          : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <button type="button" className={btn} disabled={!idle} onClick={() => void onCopy()} aria-label="Copy table as CSV">
        {feedback === "copied" ? <Check size={11} className="text-success" /> : <Copy size={11} />}
        <span>{feedback === "copied" ? "Copied" : "Copy"}</span>
      </button>
      <button
        type="button"
        className={btn}
        disabled={!idle}
        onClick={() => void onExport("csv")}
        aria-label="Export table as CSV"
      >
        {feedback === "exported" ? <Check size={11} className="text-success" /> : <Download size={11} />}
        <span>Export CSV</span>
      </button>
      <button
        type="button"
        className={btn}
        disabled={!idle}
        onClick={() => void onExport("json")}
        aria-label="Export table as JSON"
      >
        <Download size={11} />
        <span>Export JSON</span>
      </button>
      {error ? <span className="text-[11px] text-error truncate max-w-[14rem]">{error}</span> : null}
    </div>
  )
}
