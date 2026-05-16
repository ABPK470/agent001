/**
 * Tables tab — dense data grid showing every EntityTable + ALL enriched
 * recipe fields (scopeColumn, source, groundedByPipeline, enabledByDefault,
 * userControllable, archive, note). This is the panel that proves the
 * registry has full fidelity with `deploy/mssql/sync-recipes.json`.
 */

import { Check, CircleDot, Minus, ShieldAlert, X } from "lucide-react"
import type { JSX } from "react"
import type { EntityRegistryDefinition, EntityRegistryTable } from "../../types"

export interface EntityTablesProps {
  def: EntityRegistryDefinition
}

function sourceBadge(s: EntityRegistryTable["source"]): JSX.Element {
  if (!s) return <span className="text-text-faint">—</span>
  const cls = {
    "fk+pipeline":   "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    "fk-only":       "bg-amber-500/15  text-amber-300  border-amber-500/30",
    "pipeline-only": "bg-sky-500/15    text-sky-300    border-sky-500/30",
    "manual":        "bg-overlay-2     text-text-muted border-border-subtle",
  }[s]
  return (
    <span className={`inline-flex items-center rounded-sm border px-1.5 py-px text-[10px] font-mono ${cls}`}>
      {s}
    </span>
  )
}

function boolCell(v: boolean | null): JSX.Element {
  if (v === null) return <span className="text-text-faint">—</span>
  return v
    ? <Check className="h-3 w-3 text-emerald-400" />
    : <X     className="h-3 w-3 text-text-faint" />
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
  return (
    <div className="overflow-x-auto rounded-lg border border-border-subtle bg-panel">
      <table className="w-full text-xs">
        <thead className="border-b border-border-subtle bg-panel-2">
          <tr className="text-left text-text-muted">
            <th className="px-3 py-2 font-medium">#</th>
            <th className="px-3 py-2 font-medium">Table</th>
            <th className="px-3 py-2 font-medium">Scope</th>
            <th className="px-3 py-2 font-medium">FK col</th>
            <th className="px-3 py-2 font-medium">Source</th>
            <th className="px-3 py-2 font-medium text-center" title="Verified against legacy sproc body">
              <ShieldAlert className="inline h-3 w-3" />
            </th>
            <th className="px-3 py-2 font-medium text-center" title="Grounded by legacy pipeline">
              <CircleDot className="inline h-3 w-3" />
            </th>
            <th className="px-3 py-2 font-medium text-center" title="Enabled by default">def</th>
            <th className="px-3 py-2 font-medium text-center" title="User-controllable">ctl</th>
            <th className="px-3 py-2 font-medium">Archive</th>
          </tr>
        </thead>
        <tbody>
          {def.tables.map((t, i) => (
            <tr
              key={i}
              className="border-b border-border-subtle/60 last:border-0 hover:bg-overlay-2"
              title={t.note ?? undefined}
            >
              <td className="px-3 py-1.5 text-text-faint">{t.executionOrder}</td>
              <td className="px-3 py-1.5 font-mono text-text">{t.name}</td>
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
      {def.tables.some((t) => t.note) && (
        <div className="border-t border-border-subtle px-3 py-2 text-[11px] text-text-muted">
          Rows with hover-tooltips have introspection notes attached.
        </div>
      )}
    </div>
  )
}
