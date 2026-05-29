/**
 * Tables tab — dense data grid showing every EntityTable + ALL enriched
 * recipe fields (scopeColumn, source, groundedByPipeline, enabledByDefault,
 * userControllable, archive, note). This is the panel that proves the
 * registry-compatible table model has full fidelity with the published
 * sync-definition projection used by preview and execute.
 */

import { Check, CircleDot, Minus, ShieldAlert, X } from "lucide-react"
import type { JSX } from "react"
import type { EntityRegistryDefinition, EntityRegistryTable } from "../../types"

export interface EntityTablesProps {
  def: EntityRegistryDefinition
}

function sourceBadge(s: EntityRegistryTable["source"]): JSX.Element {
  if (!s) return <span className="text-text-faint">—</span>
  const tone = {
    "fk+pipeline":   "bg-success-soft text-success border-success/20",
    "fk-only":       "bg-warning-soft text-warning border-warning/20",
    "pipeline-only": "bg-info-soft text-info border-info/20",
    "manual":        "bg-overlay-2 text-text-muted border-border-subtle",
  }[s]
  const label = {
    "fk+pipeline": "FK + pipeline",
    "fk-only": "FK only",
    "pipeline-only": "Pipeline only",
    "manual": "Manual",
  }[s]
  return (
    <span className={`inline-flex items-center rounded-sm border px-1.5 py-px text-[10px] font-medium ${tone}`}>
      {label}
    </span>
  )
}

function boolCell(v: boolean | null | undefined): JSX.Element {
  if (v == null) return <span className="text-text-faint">—</span>
  return v
    ? <Check className="h-3 w-3 text-success" />
    : <X     className="h-3 w-3 text-text-muted" />
}

function scopeCell(t: EntityRegistryTable): JSX.Element {
  switch (t.scope.kind) {
    case "rootPk":
      return <span className="font-mono text-text"><span className="text-text-muted">rootPk · </span>{t.scope.column}</span>
    case "fkPath":
      return <span className="font-mono text-text"><span className="text-text-muted">fkPath · </span>{t.scope.through.length} hop</span>
    case "sql":
      return (
        <span className="font-mono text-text" title={t.scope.predicate}>
          <span className="text-text-muted">sql · </span>custom
        </span>
      )
  }
}

export function EntityTables({ def }: EntityTablesProps): JSX.Element {
  const tables = def.tables ?? []
  return (
    <div className="overflow-x-auto rounded-lg border border-border-subtle bg-panel">
      <table className="w-full text-xs">
        <thead className="border-b border-border-subtle bg-panel-2">
          <tr className="text-left text-text-muted">
            <HeaderCell label="Order" hint="Execution order inside the entity." />
            <HeaderCell label="Table name" hint="Physical source table included in this entity." />
            <HeaderCell label="Scope rule" hint="How rows are selected for this table during sync." />
            <HeaderCell label="Scope column" hint="Column used to bind this table back to the root entity." />
            <HeaderCell label="Inclusion source" hint="Why this table is present: FK graph, pipeline logic, or manual authorship." />
            <HeaderCell
              label="Verified"
              hint="Confirmed against the legacy stored procedure or authored source."
              centered
              icon={<ShieldAlert className="h-3 w-3" />}
            />
            <HeaderCell
              label="Pipeline grounded"
              hint="Backed by legacy pipeline evidence, not just inferred from FKs."
              centered
              icon={<CircleDot className="h-3 w-3" />}
            />
            <HeaderCell label="Default on" hint="Included by default in sync runs." centered />
            <HeaderCell label="Operator toggle" hint="Can be turned on or off by the operator." centered />
            <HeaderCell label="Archive table" hint="Archive/staging target associated with this table, when one exists." />
          </tr>
        </thead>
        <tbody>
          {tables.map((t, i) => (
            <tr
              key={i}
              className="border-b border-border-subtle/60 last:border-0 hover:bg-overlay-2"
              title={t.note ?? undefined}
            >
              <td className="px-3 py-2 text-text-faint tabular-nums">{t.executionOrder}</td>
              <td className="px-3 py-2 font-mono text-text">{t.name}</td>
              <td className="px-3 py-1.5">{scopeCell(t)}</td>
              <td className="px-3 py-1.5 font-mono text-text-muted">
                {t.scopeColumn ?? <Minus className="inline h-3 w-3 text-text-faint" />}
              </td>
              <td className="px-3 py-1.5">{sourceBadge(t.source)}</td>
              <td className="px-3 py-1.5 text-center">{boolCell(t.verified)}</td>
              <td className="px-3 py-1.5 text-center">{boolCell(t.groundedByPipeline)}</td>
              <td className="px-3 py-1.5 text-center">{boolCell(t.enabledByDefault)}</td>
              <td className="px-3 py-1.5 text-center">{boolCell(t.userControllable)}</td>
              <td className="px-3 py-1.5 font-mono text-text-muted">{t.archiveTable ?? <span className="text-text-faint">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {tables.some((t) => t.note) && (
        <div className="border-t border-border-subtle px-3 py-2 text-[11px] text-text-muted">
          Rows with hover-tooltips have introspection notes attached.
        </div>
      )}
    </div>
  )
}

function HeaderCell({
  label,
  hint,
  centered = false,
  icon,
}: {
  label: string
  hint: string
  centered?: boolean
  icon?: JSX.Element
}): JSX.Element {
  return (
    <th className={`px-3 py-2 font-medium ${centered ? "text-center" : "text-left"}`} title={hint}>
      <div className={`flex gap-1.5 ${centered ? "items-center justify-center" : "items-start"}`}>
        {icon}
        <div className={centered ? "text-center" : ""}>
          <div className="whitespace-nowrap text-text-secondary">{label}</div>
          <div className="mt-0.5 text-[10px] font-normal leading-tight text-text-faint">{hint}</div>
        </div>
      </div>
    </th>
  )
}
