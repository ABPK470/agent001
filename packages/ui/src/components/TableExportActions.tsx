/**
 * Per-table Copy / CSV / JSON — bare icon+label controls (no pill).
 * Parents overlay these on the table header (top-right) so the table keeps
 * its full width; no permanent side gutter.
 */

import { Braces, Check, Copy, Sheet } from "lucide-react"
import { useEffect, useRef, useState, type JSX } from "react"
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
   * Stays visible while Copy/CSV/JSON feedback or an error is showing.
   */
  revealOnHover?: boolean
}

/** Which control just succeeded — drives the green check on that button only. */
type FeedbackAction = "copy" | "csv" | "json"

export function TableExportActions({
  headers,
  rows,
  source,
  disabled = false,
  compact = false,
  revealOnHover = false,
}: TableExportActionsProps): JSX.Element {
  const [feedback, setFeedback] = useState<FeedbackAction | null>(null)
  const [busyAction, setBusyAction] = useState<FeedbackAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
    }
  }, [])

  function scheduleClearFeedback(): void {
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
    clearTimerRef.current = setTimeout(() => {
      setFeedback(null)
      clearTimerRef.current = null
    }, 1600)
  }

  async function onCopy(): Promise<void> {
    if (disabled || busyAction || rows.length === 0) return
    setError(null)
    setBusyAction("copy")
    try {
      await copyChatTableCsv(headers, rows)
      setFeedback("copy")
      scheduleClearFeedback()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Copy failed")
    } finally {
      setBusyAction(null)
    }
  }

  async function onExport(format: TableExportFormat): Promise<void> {
    if (disabled || busyAction || rows.length === 0) return
    setError(null)
    setBusyAction(format)
    try {
      await exportChatTable({ source, format, headers, rows })
      setFeedback(format)
      scheduleClearFeedback()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed")
    } finally {
      setBusyAction(null)
    }
  }

  const btn = [
    "inline-flex items-center gap-1 rounded-sm py-0.5",
    compact ? "text-[12px] px-0.5" : "text-sm px-1",
    "text-text",
    "disabled:opacity-40 disabled:pointer-events-none cursor-pointer",
  ].join(" ")

  const idle = !disabled && !busyAction
  const pinnedVisible = Boolean(feedback || busyAction || error)

  return (
    <div
      className={[
        "flex flex-wrap items-center gap-1 min-w-0",
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
      <button
        type="button"
        className={btn}
        disabled={!idle}
        onClick={() => void onCopy()}
        aria-label="Copy table as CSV"
      >
        {feedback === "copy" ? <Check size={11} className="text-success" /> : <Copy size={11} />}
        <span>{feedback === "copy" ? "Copied" : "Copy"}</span>
      </button>
      <button
        type="button"
        className={btn}
        disabled={!idle}
        onClick={() => void onExport("csv")}
        aria-label="Export table as CSV"
      >
        {feedback === "csv" ? <Check size={11} className="text-success" /> : <Sheet size={11} />}
        <span>CSV</span>
      </button>
      <button
        type="button"
        className={btn}
        disabled={!idle}
        onClick={() => void onExport("json")}
        aria-label="Export table as JSON"
      >
        {feedback === "json" ? <Check size={11} className="text-success" /> : <Braces size={11} />}
        <span>JSON</span>
      </button>
      {error ? (
        <span className="text-[11px] text-error truncate max-w-[14rem]">{error}</span>
      ) : null}
    </div>
  )
}
