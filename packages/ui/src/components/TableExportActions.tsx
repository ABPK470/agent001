/**
 * Per-table Copy / CSV / JSON controls for chat markdown tables.
 * Product verb for file delivery: Export (CSV / JSON). Copy = clipboard CSV.
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
  /** Vertical rail beside the table (outside the border). */
  orientation?: "horizontal" | "vertical"
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
  orientation = "horizontal",
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

  const vertical = orientation === "vertical"
  const btn = compact
    ? [
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px]",
        "text-text-muted hover:text-text hover:bg-overlay-hover",
        "disabled:opacity-40 disabled:pointer-events-none cursor-pointer",
        vertical ? "w-full justify-start" : "",
      ].join(" ")
    : [
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-sm",
        "text-text-muted hover:text-text hover:bg-overlay-2",
        "disabled:opacity-40 disabled:pointer-events-none cursor-pointer",
        vertical ? "w-full justify-start" : "",
      ].join(" ")

  const idle = !disabled && !busyAction
  const pinnedVisible = Boolean(feedback || busyAction || error)

  return (
    <div
      className={[
        vertical ? "flex flex-col items-stretch gap-0.5" : "flex flex-wrap items-center gap-1",
        "min-w-0",
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
        <span className={`text-[11px] text-error ${vertical ? "max-w-[4.5rem] break-words" : "truncate max-w-[14rem]"}`}>
          {error}
        </span>
      ) : null}
    </div>
  )
}
