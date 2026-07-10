import { ChevronDown, ChevronRight, Minus, Plus } from "lucide-react"
import { useState, type ReactNode } from "react"

import { ModalShell } from "./chrome"
import { DIFF } from "./constants"
import {
  formatCellFull,
  partitionSampleRowColumns,
  sampleRowColumns,
  sampleRowDetailSubtitle,
  sampleRowDetailTitle,
  type SampleRowDetail,
} from "./plan-table-values"

export const PLAN_ROW_DIFF_BODY_CLASS = "flex-1 min-h-0 overflow-y-auto px-6 py-4"
export const PLAN_ROW_DIFF_SUMMARY_CLASS = "shrink-0 border-b border-border-subtle bg-elevated px-6 py-3"

export function PlanSampleRowModal({ detail, onClose }: {
  detail: SampleRowDetail
  onClose: () => void
}) {
  const { kind, sample } = detail
  const columns = sampleRowColumns(sample)
  const { changed, unchanged } = partitionSampleRowColumns(sample)

  return (
    <ModalShell
      title={sampleRowDetailTitle(kind)}
      subtitle={sampleRowDetailSubtitle(detail)}
      size="default"
      onClose={onClose}
    >
      <DiffSummaryBar kind={kind} changed={changed} unchanged={unchanged} columnCount={columns.length} />
      <div className={PLAN_ROW_DIFF_BODY_CLASS}>
        {kind === "update"
          ? <UpdateRowDiff sample={sample} changed={changed} unchanged={unchanged} />
          : <InsertDeleteRowDiff kind={kind} sample={sample} columns={columns} />}
      </div>
    </ModalShell>
  )
}

function DiffSummaryBar({ kind, changed, unchanged, columnCount }: {
  kind: SampleRowDetail["kind"]
  changed: string[]
  unchanged: string[]
  columnCount: number
}) {
  if (kind === "update") {
    return (
      <div className={PLAN_ROW_DIFF_SUMMARY_CLASS}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <span className="font-semibold" style={{ color: DIFF.upd }}>
            {changed.length} column{changed.length === 1 ? "" : "s"} will change
          </span>
          {changed.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {changed.map((column) => (
                <span
                  key={column}
                  className="rounded border px-2 py-0.5 text-xs font-mono"
                  style={{ color: DIFF.upd, borderColor: "color-mix(in srgb, var(--color-viz-peach) 35%, transparent)", backgroundColor: "color-mix(in srgb, var(--color-viz-peach) 10%, transparent)" }}
                >
                  {column}
                </span>
              ))}
            </div>
          )}
          {unchanged.length > 0 && (
            <span className="text-text-muted text-xs font-mono">
              · {unchanged.length} unchanged
            </span>
          )}
        </div>
      </div>
    )
  }

  const label = kind === "insert" ? "insert" : "delete"
  const color = kind === "insert" ? DIFF.ins : DIFF.del
  return (
    <div className={PLAN_ROW_DIFF_SUMMARY_CLASS}>
      <span className="text-sm font-semibold" style={{ color }}>
        {columnCount} column{columnCount === 1 ? "" : "s"} to {label}
      </span>
    </div>
  )
}

function UpdateRowDiff({ sample, changed, unchanged }: {
  sample: SampleRowDetail["sample"]
  changed: string[]
  unchanged: string[]
}) {
  const [showUnchanged, setShowUnchanged] = useState(false)

  return (
    <div className="space-y-4">
      {changed.length > 0 ? (
        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">Changes</h3>
          {changed.map((column) => (
            <DiffFieldBlock
              key={column}
              column={column}
              oldValue={sample.oldValues?.[column]}
              newValue={sample.newValues?.[column]}
            />
          ))}
        </section>
      ) : (
        <p className="text-sm text-text-muted font-mono">No column differences detected for this row.</p>
      )}

      {unchanged.length > 0 && (
        <section className="border border-border/40 rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => setShowUnchanged(!showUnchanged)}
            className="w-full flex items-center gap-2 px-3 py-2.5 text-left text-sm text-text-muted hover:bg-elevated/40 transition-colors"
          >
            {showUnchanged
              ? <ChevronDown size={14} className="shrink-0" />
              : <ChevronRight size={14} className="shrink-0" />}
            <span className="font-medium">{unchanged.length} unchanged column{unchanged.length === 1 ? "" : "s"}</span>
            <span className="text-xs font-mono opacity-60 truncate">{unchanged.join(", ")}</span>
          </button>
          {showUnchanged && (
            <div className="border-t border-border/30 divide-y divide-border/20 bg-base/20">
              {unchanged.map((column) => (
                <UnchangedFieldRow
                  key={column}
                  column={column}
                  value={sample.newValues?.[column] ?? sample.oldValues?.[column]}
                />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}

function DiffFieldBlock({ column, oldValue, newValue }: {
  column: string
  oldValue: unknown
  newValue: unknown
}) {
  return (
    <article className="rounded-lg border border-border/50 overflow-hidden bg-surface/30">
      <header className="flex items-center justify-between gap-3 px-3 py-2 border-b border-border/30 bg-elevated/70">
        <span className="font-mono text-sm font-medium text-text">{column}</span>
        <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: DIFF.upd }}>modified</span>
      </header>
      <div className="grid grid-cols-1 lg:grid-cols-2 min-w-0">
        <DiffValuePanel
          label="Current (target)"
          icon={<Minus size={12} />}
          value={oldValue}
          tone="removed"
        />
        <DiffValuePanel
          label="After sync (source)"
          icon={<Plus size={12} />}
          value={newValue}
          tone="added"
        />
      </div>
    </article>
  )
}

function DiffValuePanel({ label, icon, value, tone }: {
  label: string
  icon: ReactNode
  value: unknown
  tone: "removed" | "added"
}) {
  const isRemoved = tone === "removed"
  const accent = isRemoved ? DIFF.del : DIFF.upd
  const panelBg = isRemoved
    ? "color-mix(in srgb, var(--color-viz-coral) 6%, var(--color-surface))"
    : "color-mix(in srgb, var(--color-viz-peach) 8%, var(--color-surface))"
  const borderAccent = isRemoved
    ? "color-mix(in srgb, var(--color-viz-coral) 40%, transparent)"
    : "color-mix(in srgb, var(--color-viz-peach) 40%, transparent)"

  return (
    <div
      className="min-w-0 border-t lg:border-t-0 lg:border-l first:lg:border-l-0 border-border/30"
      style={{ backgroundColor: panelBg }}
    >
      <div
        className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold border-b"
        style={{ color: accent, borderColor: borderAccent, backgroundColor: "color-mix(in srgb, currentColor 8%, transparent)" }}
      >
        {icon}
        <span>{label}</span>
      </div>
      <pre
        className="m-0 p-3 text-sm font-mono whitespace-pre-wrap break-all text-text min-w-0"
        style={{ color: isRemoved ? DIFF.oldRow : DIFF.upd }}
      >
        {formatCellFull(value)}
      </pre>
    </div>
  )
}

function UnchangedFieldRow({ column, value }: { column: string; value: unknown }) {
  return (
    <div className="grid grid-cols-[minmax(8rem,12rem)_1fr] gap-3 px-3 py-2.5 text-sm font-mono">
      <span className="text-text-muted truncate" title={column}>{column}</span>
      <pre className="m-0 whitespace-pre-wrap break-all text-text/80 min-w-0">{formatCellFull(value)}</pre>
    </div>
  )
}

function InsertDeleteRowDiff({ kind, sample, columns }: {
  kind: "insert" | "delete"
  sample: SampleRowDetail["sample"]
  columns: string[]
}) {
  const color = kind === "insert" ? DIFF.ins : DIFF.del
  const label = kind === "insert" ? "Value to insert" : "Value to delete"

  return (
    <section className="space-y-3">
      {columns.map((column) => (
        <article
          key={column}
          className="rounded-lg border overflow-hidden"
          style={{ borderColor: `color-mix(in srgb, ${color} 30%, transparent)` }}
        >
          <header
            className="px-3 py-2 border-b font-mono text-sm font-medium"
            style={{
              color,
              borderColor: `color-mix(in srgb, ${color} 25%, transparent)`,
              backgroundColor: `color-mix(in srgb, ${color} 8%, transparent)`,
            }}
          >
            {column}
          </header>
          <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted border-b border-border/20">
            {label}
          </div>
          <pre
            className="m-0 p-3 text-sm font-mono whitespace-pre-wrap break-all min-w-0"
            style={{ color }}
          >
            {formatCellFull(sample.values?.[column])}
          </pre>
        </article>
      ))}
    </section>
  )
}
