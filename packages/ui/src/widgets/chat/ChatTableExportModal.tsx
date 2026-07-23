/**
 * /export — pick answer tables from thread runs and Export as CSV or JSON.
 * Product verb: Export. One path: audited POST /api/runs/:id/export/tables.
 * Chrome: ModalShell (theme surface + shared scrim) — same dialect as platform modals.
 */

import { extractAnswerTables, type TableExportFormat } from "@mia/shared-types"
import { FileSpreadsheet } from "lucide-react"
import { useEffect, useMemo, useState, type JSX } from "react"
import { LabeledCheckbox } from "../../components/Checkbox"
import {
  exportChatTable,
  exportChatTablesJson,
} from "../../lib/chat-table-export"
import type { Run } from "../../types"
import { ModalShell } from "../entity-registry/ModalShell"

export interface ChatTableExportModalProps {
  open: boolean
  onClose: () => void
  runs: Run[]
  /** Prefer selecting tables from this run when the modal opens. */
  preferredRunId?: string | null
  onExported?: (message: string) => void
  onError?: (message: string) => void
}

interface SelectableTable {
  key: string
  runId: string
  runLabel: string
  tableIndex: number
  title: string
  rowCount: number
  columnCount: number
}

function buildSelectableTables(runs: Run[]): SelectableTable[] {
  const sorted = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const out: SelectableTable[] = []
  for (const run of sorted) {
    if (!run.answer) continue
    const tables = extractAnswerTables(run.answer)
    if (tables.length === 0) continue
    const runLabel = `${run.goal.trim().slice(0, 48) || "Run"}${run.goal.trim().length > 48 ? "…" : ""} · ${run.id.slice(0, 8)}`
    for (const table of tables) {
      out.push({
        key: `${run.id}:${table.index}`,
        runId: run.id,
        runLabel,
        tableIndex: table.index,
        title: table.title,
        rowCount: table.rows.length,
        columnCount: table.headers.length,
      })
    }
  }
  return out
}

export function ChatTableExportModal({
  open,
  onClose,
  runs,
  preferredRunId,
  onExported,
  onError,
}: ChatTableExportModalProps): JSX.Element | null {
  const tables = useMemo(() => buildSelectableTables(runs), [runs])
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [format, setFormat] = useState<TableExportFormat>("csv")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    const next = new Set<string>()
    const preferred = preferredRunId
      ? tables.filter((t) => t.runId === preferredRunId)
      : tables
    const seed = preferred.length > 0 ? preferred : tables
    for (const table of seed.slice(0, 1)) next.add(table.key)
    setSelected(next)
    setFormat("csv")
    setBusy(false)
  }, [open, preferredRunId, tables])

  const runsInList = useMemo(() => {
    const order: string[] = []
    const labels = new Map<string, string>()
    for (const table of tables) {
      if (!labels.has(table.runId)) {
        order.push(table.runId)
        labels.set(table.runId, table.runLabel)
      }
    }
    return order.map((runId) => ({
      runId,
      label: labels.get(runId) ?? runId,
      tables: tables.filter((t) => t.runId === runId),
    }))
  }, [tables])

  function toggleKey(key: string, on: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  }

  function selectAllInRun(runId: string, on: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const table of tables) {
        if (table.runId !== runId) continue
        if (on) next.add(table.key)
        else next.delete(table.key)
      }
      return next
    })
  }

  async function onExport(): Promise<void> {
    const picked = tables.filter((t) => selected.has(t.key))
    if (picked.length === 0) {
      onError?.("Select at least one table")
      return
    }

    setBusy(true)
    try {
      if (format === "csv") {
        const names: string[] = []
        for (const table of picked) {
          const result = await exportChatTable({
            source: { kind: "run", runId: table.runId, tableIndex: table.tableIndex },
            format: "csv",
            headers: [],
            rows: [],
          })
          names.push(result.filename)
        }
        onExported?.(
          picked.length === 1
            ? `Exported ${names[0]}`
            : `Exported ${picked.length} CSV files`,
        )
        onClose()
        return
      }

      const byRun = new Map<string, number[]>()
      for (const table of picked) {
        const list = byRun.get(table.runId) ?? []
        list.push(table.tableIndex)
        byRun.set(table.runId, list)
      }
      const names: string[] = []
      for (const [runId, tableIndexes] of byRun) {
        const result = await exportChatTablesJson({ runId, tableIndexes })
        names.push(result.filename)
      }
      onExported?.(
        names.length === 1
          ? `Exported ${names[0]}`
          : `Exported ${names.length} JSON files`,
      )
      onClose()
    } catch (e) {
      onError?.(e instanceof Error ? e.message : "Export failed")
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <ModalShell
      title="Export tables"
      subtitle="Markdown tables from run answers · CSV or JSON"
      icon={<FileSpreadsheet size={18} />}
      size="detail"
      onClose={onClose}
      footer={
        <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs text-text-muted shrink-0">Format</span>
            <div className="flex rounded-md border border-border-subtle overflow-hidden bg-panel">
              <button
                type="button"
                className={[
                  "px-3 py-1.5 text-xs cursor-pointer transition-colors",
                  format === "csv"
                    ? "bg-accent text-text-on-accent"
                    : "text-text-muted hover:bg-overlay-hover hover:text-text",
                ].join(" ")}
                onClick={() => setFormat("csv")}
              >
                CSV
              </button>
              <button
                type="button"
                className={[
                  "px-3 py-1.5 text-xs cursor-pointer border-l border-border-subtle transition-colors",
                  format === "json"
                    ? "bg-accent text-text-on-accent"
                    : "text-text-muted hover:bg-overlay-hover hover:text-text",
                ].join(" ")}
                onClick={() => setFormat("json")}
              >
                JSON
              </button>
            </div>
            {format === "csv" && selected.size > 1 ? (
              <span className="text-[11px] text-text-muted truncate">One file per table</span>
            ) : null}
          </div>
          <div className="flex justify-end gap-2 shrink-0">
            <button
              type="button"
              className="px-3 py-1.5 text-sm rounded-lg text-text-muted hover:bg-overlay-hover hover:text-text cursor-pointer disabled:opacity-40"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="px-3 py-1.5 text-sm rounded-lg bg-accent text-text-on-accent hover:bg-accent-hover disabled:opacity-40 cursor-pointer"
              onClick={() => void onExport().catch((err: unknown) => { console.error("[mia]", err) })}
              disabled={busy || selected.size === 0 || tables.length === 0}
            >
              {busy ? "Exporting…" : "Export"}
            </button>
          </div>
        </div>
      }
    >
      <div className="min-h-0 flex-1 overflow-auto px-6 py-4 space-y-4">
        {tables.length === 0 ? (
          <p className="text-sm text-text-muted">
            No markdown tables in this thread yet. Tables appear when a run answer includes a markdown table.
          </p>
        ) : (
          runsInList.map((group) => {
            const allOn = group.tables.every((t) => selected.has(t.key))
            return (
              <div key={group.runId} className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-medium text-text-muted truncate">{group.label}</div>
                  <button
                    type="button"
                    className="text-[11px] text-accent hover:underline cursor-pointer shrink-0"
                    onClick={() => selectAllInRun(group.runId, !allOn)}
                  >
                    {allOn ? "Clear" : "Select all"}
                  </button>
                </div>
                <div className="space-y-1.5">
                  {group.tables.map((table) => (
                    <LabeledCheckbox
                      key={table.key}
                      layout="card"
                      checked={selected.has(table.key)}
                      onChange={(on) => toggleKey(table.key, on)}
                      label={table.title}
                      hint={`${table.rowCount} row${table.rowCount === 1 ? "" : "s"} · ${table.columnCount} col${table.columnCount === 1 ? "" : "s"} · #${table.tableIndex}`}
                    />
                  ))}
                </div>
              </div>
            )
          })
        )}
      </div>
    </ModalShell>
  )
}
