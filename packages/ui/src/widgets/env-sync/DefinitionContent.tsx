import { AlertTriangle, BookOpen, CheckCircle2, Database, Key, ShieldAlert, ShieldCheck, Ship } from "lucide-react"

import { useStore } from "../../store"
import type { PublishedSyncDefinition } from "../../types"
import { DIFF, normalizeOptionalTableSelection } from "./constants"
import {
  DEFINITION_MODAL_BODY_CLASS,
  DEFINITION_MODAL_FOOTER_CLASS,
  DEFINITION_MODAL_HEADER_CLASS,
  DEFINITION_TABLE_BODY_SCROLL_CLASS,
  DEFINITION_TABLE_HEADER_CLASS,
  DEFINITION_TABLE_PANEL_CLASS,
  DEFINITION_TABLE_SHELL_CLASS,
} from "./definition-content-layout"

export function DefinitionContent({ definition }: { definition: PublishedSyncDefinition | null }) {
  const enabledOptionalTablesRaw = useStore((s) => s.envSyncForm.enabledOptionalTables)
  const setForm = useStore((s) => s.setEnvSyncForm)

  if (!definition) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 py-16 text-text-muted">
        <BookOpen size={24} className="opacity-30" />
        <p className="text-sm">No published definition loaded.</p>
        <p className="text-xs">Compile and publish the repo definitions to make this entity available for sync.</p>
      </div>
    )
  }

  const verified = definition.metadata.tables.filter((table) => table.verified).length
  const total = definition.metadata.tables.length
  const allVerified = verified === total
  const optionalTables = definition.metadata.tables.filter((table) => table.userControllable)
  const enabledOptionalTables = normalizeOptionalTableSelection(definition, enabledOptionalTablesRaw)
  const enabledOptional = new Set(enabledOptionalTables)

  function toggleOptionalTable(tableName: string) {
    const next = enabledOptional.has(tableName)
      ? enabledOptionalTables.filter((name) => name !== tableName)
      : [...enabledOptionalTables, tableName]
    setForm({ enabledOptionalTables: next })
  }

  return (
    <div className={DEFINITION_MODAL_BODY_CLASS}>
      <div className={DEFINITION_MODAL_HEADER_CLASS}>
        <div className="px-5 pt-4">
          <div className="rounded-lg border border-border-subtle bg-overlay-1/40 px-3 py-2.5 text-[11px] text-text-muted">
            This is the published runtime definition used to compile preview plans. Pre-preview controls in EnvSync are now sourced from this published definition rather than the old recipe bundle.
          </div>
        </div>

        <div className="px-5 py-4 border-b border-border/40">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 text-sm">
            <div className="flex items-center gap-2">
              <Database size={13} className="text-text-muted/50 shrink-0" />
              <span className="text-text-muted">Root table</span>
              <span className="font-mono text-text ml-auto">{definition.rootTable}</span>
            </div>
            <div className="flex items-center gap-2">
              <Key size={13} className="text-text-muted/50 shrink-0" />
              <span className="text-text-muted">Primary key</span>
              <span className="font-mono text-text ml-auto">{definition.idColumn}</span>
            </div>
            <div className="flex items-center gap-2">
              <Ship size={13} className="text-text-muted/50 shrink-0" />
              <span className="text-text-muted">Published version</span>
              <span className="font-mono text-text ml-auto text-xs">{definition.publishedVersion}</span>
            </div>
            <div className="flex items-center gap-2">
              {allVerified
                ? <ShieldCheck size={13} className="shrink-0 text-accent" />
                : <ShieldAlert size={13} className="text-warning shrink-0" />}
              <span className="text-text-muted">Verified</span>
              <span className={`font-mono ml-auto ${allVerified ? "text-accent" : "text-warning"}`}>{verified}/{total} tables</span>
            </div>
          </div>
        </div>

        {optionalTables.length > 0 && (
          <div className="px-5 pt-4">
            <div className="rounded border border-border-subtle bg-elevated/20 px-3 py-3 text-sm text-text-muted">
              <div className="flex items-center justify-between gap-3">
                <span>FK-only tables are inferred from relational closure and stay off until you enable them.</span>
                <span className="font-mono text-text">{enabledOptionalTables.length}/{optionalTables.length} enabled</span>
              </div>
            </div>
          </div>
        )}

        <div className="px-5 pt-3 pb-2">
          <div className="text-xs text-text-muted/60">Dependency tables ({total})</div>
        </div>
      </div>

      <div className={DEFINITION_TABLE_PANEL_CLASS}>
        <div className={DEFINITION_TABLE_SHELL_CLASS}>
          <div className={DEFINITION_TABLE_HEADER_CLASS}>
            <span className="text-right">#</span>
            <span>Table</span>
            <span className="w-28 text-right">Scope column</span>
            <span className="w-20 text-center">Source</span>
            <span className="w-16 text-center">Status</span>
            <span className="w-20 text-center">Use</span>
          </div>
          <div className={DEFINITION_TABLE_BODY_SCROLL_CLASS}>
            {definition.metadata.tables.map((table, index) => (
              <div
                key={table.name}
                className={`grid grid-cols-[2rem_1fr_auto_auto_auto_auto] gap-2 px-3 py-2 items-center text-sm ${index < definition.metadata.tables.length - 1 ? "border-b border-border/20" : ""} hover:bg-elevated/20 transition-colors`}
                title={table.predicate}
              >
                <span className="font-mono text-text-muted/40 text-right tabular-nums text-xs">{index + 1}</span>
                <span className="font-mono text-text truncate">{table.name}</span>
                <span className="font-mono text-text-muted text-right w-28 truncate text-xs">{table.scopeColumn ?? "—"}</span>
                <span className="w-20 text-center">
                  <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                    table.source === "fk+pipeline" ? "bg-accent/10 text-accent"
                      : table.source === "pipeline-only" ? "bg-warning/10 text-warning"
                      : "bg-info-soft text-info"
                  }`}>{table.source === "fk+pipeline" ? "fk+pl" : table.source === "pipeline-only" ? "pl" : "fk"}</span>
                </span>
                <span className="w-16 text-center">
                  {table.verified
                    ? <CheckCircle2 size={14} className="inline" style={{ color: DIFF.ins }} />
                    : <AlertTriangle size={14} className="inline text-warning" />}
                </span>
                <span className="w-20 text-center">
                  {table.userControllable ? (
                    <button
                      onClick={() => toggleOptionalTable(table.name)}
                      className={`min-w-[3.5rem] rounded px-2 py-1 text-xs font-mono transition-colors ${enabledOptional.has(table.name) ? "bg-accent/15 text-accent hover:bg-accent/20" : "bg-overlay-2 text-text-muted hover:text-text hover:bg-overlay-3"}`}
                    >
                      {enabledOptional.has(table.name) ? "on" : "off"}
                    </button>
                  ) : (
                    <span className="inline-block min-w-[3.5rem] rounded px-2 py-1 text-[10px] font-mono uppercase tracking-wide bg-overlay-2 text-text-muted/70">auto</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className={DEFINITION_MODAL_FOOTER_CLASS}>
        {definition.metadata.discrepancies.length > 0 && (
          <div className="px-5 pt-4">
            <div className="border border-warning/30 rounded overflow-hidden">
              <div className="px-3 py-2 bg-warning/5 border-b border-warning/20 flex items-center gap-2">
                <AlertTriangle size={13} className="text-warning" />
                <span className="text-sm text-warning font-medium">{definition.metadata.discrepancies.length} discrepanc{definition.metadata.discrepancies.length === 1 ? "y" : "ies"}</span>
              </div>
              <div className="px-3 py-2 space-y-2">
                {definition.metadata.discrepancies.map((discrepancy, index) => (
                  <div key={index} className="text-sm flex items-start gap-2">
                    <span className="text-warning font-mono text-xs bg-warning/10 px-1.5 py-0.5 rounded shrink-0 mt-0.5">{discrepancy.kind}</span>
                    <div>
                      {discrepancy.table !== "*" && <span className="font-mono text-text">{discrepancy.table} — </span>}
                      <span className="text-text-muted">{discrepancy.note}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="px-5 py-3 flex items-center justify-between text-xs text-text-muted/40">
          <span className="font-mono">owner {definition.ownership.team}{definition.ownership.owner ? ` · ${definition.ownership.owner}` : ""}</span>
          <span>Published {definition.publishedAt ? new Date(definition.publishedAt).toLocaleDateString() : "—"}</span>
        </div>
      </div>
    </div>
  )
}
