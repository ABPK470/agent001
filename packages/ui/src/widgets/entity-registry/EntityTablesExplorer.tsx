/**
 * Compact table list — summary + scope on two lines; click row to expand full details.
 */

import { Check, ChevronDown, Minus, X } from "lucide-react"
import { useMemo, useState, type JSX } from "react"
import type { EntityRegistryTable } from "../../types"
import { PANEL } from "./chrome"
import { DetailField, DetailGrid } from "./DetailField"
import { scopeSummary, sortedTables, tableSourceLabel } from "./definition-helpers"

function DefaultOnIndicator({ enabled }: { enabled: boolean | null | undefined }): JSX.Element {
  if (enabled === true) {
    return <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-label="Enabled by default" />
  }
  if (enabled === false) {
    return <X className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-label="Disabled by default" />
  }
  return <Minus className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden />
}

function scopeSecondRow(table: EntityRegistryTable): string {
  switch (table.scope.kind) {
    case "rootPk":
      return `rootPk · ${table.scope.column}`
    case "sql":
      return table.scope.predicate
    default:
      return table.scope.kind
  }
}

export function EntityTableDetail({ table }: { table: EntityRegistryTable }): JSX.Element {
  return (
    <DetailGrid>
      <DetailField label="Table" value={table.name} mono />
      <DetailField label="Order" value={table.executionOrder} />
      <DetailField label="Scope" value={scopeSummary(table.scope)} mono />
      <DetailField label="Source" value={tableSourceLabel(table.source)} />
      <DetailField label="Scope column" value={table.scopeColumn} mono />
      <DetailField label="Archive table" value={table.archiveTable} mono />
      <DetailField
        label="Default on"
        value={table.enabledByDefault == null ? null : table.enabledByDefault ? "Yes" : "No"}
      />
      <DetailField
        label="User controllable"
        value={table.userControllable == null ? null : table.userControllable ? "Yes" : "No"}
      />
      {table.note?.trim() && <DetailField label="Note" value={table.note} span={2} />}
      {table.scope.kind === "sql" && (
        <DetailField label="SQL scope" value={table.scope.predicate} mono span={2} />
      )}
    </DetailGrid>
  )
}

function EntityTableRow({
  table,
  expanded,
  onToggle,
}: {
  table: EntityRegistryTable
  expanded: boolean
  onToggle: () => void
}): JSX.Element {
  const note = table.note?.trim()

  return (
    <li
      className={[
        "border-b border-border-subtle last:border-b-0",
        note ? "border-l-2 border-l-accent" : "",
        expanded ? "bg-elevated/20" : "",
      ].join(" ")}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-elevated/50"
      >
        <span className="w-5 shrink-0 pt-0.5 text-right font-mono text-sm tabular-nums text-text-faint">
          {table.executionOrder}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-xs font-medium text-text">
            {table.name}
          </span>
          <span className="entity-table-row__scope mt-0.5 block">
            {scopeSecondRow(table)}
          </span>
        </span>
        <span className="shrink-0 rounded border border-border-subtle bg-panel px-1.5 py-0.5 text-xs font-medium text-text-muted">
          {tableSourceLabel(table.source)}
        </span>
        <span className="shrink-0 pt-0.5">
          <DefaultOnIndicator enabled={table.enabledByDefault} />
        </span>
        <ChevronDown
          className={[
            "h-3.5 w-3.5 shrink-0 pt-0.5 text-text-faint transition-transform",
            expanded ? "rotate-180" : "",
          ].join(" ")}
          aria-hidden
        />
      </button>

      {expanded && (
        <div className="border-t border-border-subtle/60 px-3 py-3 pl-11">
          <EntityTableDetail table={table} />
        </div>
      )}
    </li>
  )
}

export interface EntityTablesExplorerProps {
  tables: EntityRegistryTable[]
  emptyMessage?: string
}

export function EntityTablesExplorer({
  tables,
  emptyMessage = "No tables in this definition.",
}: EntityTablesExplorerProps): JSX.Element {
  const sorted = useMemo(() => sortedTables(tables), [tables])
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())

  function toggle(index: number): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  if (sorted.length === 0) {
    return <p className="text-sm text-text-muted">{emptyMessage}</p>
  }

  return (
    <ol className={PANEL}>
      {sorted.map((table, index) => (
        <EntityTableRow
          key={`${table.name}-${table.executionOrder}-${index}`}
          table={table}
          expanded={expanded.has(index)}
          onToggle={() => toggle(index)}
        />
      ))}
    </ol>
  )
}
