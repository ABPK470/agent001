/**
 * Per-table Copy / CSV / JSON — bare icon+label controls (no pill).
 * Parents overlay these on the table header (top-right) so the table keeps
 * its full width; no permanent side gutter.
 */

import type { TableExportFormat } from "@mia/shared-types"
import { Braces, Check, Copy, Sheet } from "lucide-react"
import { useEffect, useRef, useState, type JSX } from "react"
import {
  copyChatTableCsv,
  exportChatTable,
  type ChatTableExportSource,
} from "../lib/chat-table-export"

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
  /**
   * Solid surface chip (same element that fades on hover) so header text
   * under the controls is covered only while the actions are visible.
   * Matches the chat scroll surface — not a darker canvas slab.
   */
  overlayChip?: boolean
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
  overlayChip = false,
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
    "inline-flex items-center gap-0.5 rounded-sm px-1 py-0.5",
    // Match table header band (15px / leading-6) — not leading-none, which
    // left the chip sitting too high in the th padding.
    compact ? "text-[13px] leading-5" : "text-[15px] leading-6",
    "text-text hover:bg-overlay-2",
    "disabled:opacity-40 disabled:pointer-events-none disabled:hover:bg-transparent cursor-pointer",
  ].join(" ")

  const idle = !disabled && !busyAction
  const pinnedVisible = Boolean(feedback || busyAction || error)
  const iconSize = compact ? 11 : 12

  return (
    <div
      className={[
        "flex flex-wrap items-center gap-0 min-w-0",
        // Chip bg lives here (not a parent) so idle opacity:0 hides it too.
        overlayChip ? "rounded-md px-0.5 py-0.5" : "",
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
      style={
        overlayChip
          ? {
              // Match the chat transcript surface (light home = panel, dark = canvas).
              backgroundColor: "var(--chathome-scroll-fade, var(--canvas))",
            }
          : undefined
      }
    >
      <button
        type="button"
        className={btn}
        disabled={!idle}
        onClick={() => void onCopy()}
        aria-label="Copy table as CSV"
      >
        {feedback === "copy" ? <Check size={iconSize} className="text-success" /> : <Copy size={iconSize} />}
        <span>{feedback === "copy" ? "Copied" : "Copy"}</span>
      </button>
      <button
        type="button"
        className={btn}
        disabled={!idle}
        onClick={() => void onExport("csv")}
        aria-label="Export table as CSV"
      >
        {feedback === "csv" ? <Check size={iconSize} className="text-success" /> : <Sheet size={iconSize} />}
        <span>CSV</span>
      </button>
      <button
        type="button"
        className={btn}
        disabled={!idle}
        onClick={() => void onExport("json")}
        aria-label="Export table as JSON"
      >
        {feedback === "json" ? <Check size={iconSize} className="text-success" /> : <Braces size={iconSize} />}
        <span>JSON</span>
      </button>
      {error ? (
        <span className="text-[11.5px] text-error truncate max-w-[14rem] px-1">{error}</span>
      ) : null}
    </div>
  )
}
