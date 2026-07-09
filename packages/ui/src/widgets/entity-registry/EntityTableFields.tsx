import { Loader2 } from "lucide-react"
import type { JSX, ReactNode } from "react"
import { useCallback, useRef, useState } from "react"
import { api } from "../../api"
import { Listbox } from "../../components/Listbox"
import type { EntityRegistryTable, EntityRegistryTableScope } from "../../types"
import { mergeTableSuggestion, tableSuggestionIsActionable } from "./entity-edit-form"

function FieldLabel({ label }: { label: string }): JSX.Element {
  return <span className="mb-1 block text-xs uppercase tracking-wider text-text-muted">{label}</span>
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <FieldLabel label={label} />
      {children}
    </label>
  )
}

const SCOPE_KIND_OPTIONS = [
  { value: "rootPk" as const, label: "Root PK column" },
  { value: "sql" as const, label: "SQL scope" },
]

const SOURCE_OPTIONS = [
  { value: "fk+pipeline" as const, label: "FK + pipeline" },
  { value: "fk-only" as const, label: "FK only" },
  { value: "pipeline-only" as const, label: "Pipeline only" },
  { value: "manual" as const, label: "Manual" },
]

export interface EntityTableEntityContext {
  rootTable: string
  idColumn: string
}

export interface EntityTableFieldsProps {
  table: EntityRegistryTable
  onChange?: (table: EntityRegistryTable) => void
  entityContext?: EntityTableEntityContext | null
  readOnly?: boolean
}

export function EntityTableFields({
  table,
  onChange,
  entityContext,
  readOnly = false,
}: EntityTableFieldsProps): JSX.Element {
  const touchedRef = useRef(new Set<string>())
  const tableRef = useRef(table)
  tableRef.current = table

  const [suggestBusy, setSuggestBusy] = useState(false)
  const [suggestNote, setSuggestNote] = useState<string | null>(null)

  const markTouched = useCallback((field: string) => {
    touchedRef.current.add(field)
  }, [])

  const applySuggestion = useCallback(
    async (tableName: string) => {
      if (readOnly || !onChange) return
      if (!entityContext?.rootTable.trim() || !entityContext.idColumn.trim()) return
      const trimmed = tableName.trim()
      if (trimmed.length < 3) return
      setSuggestBusy(true)
      setSuggestNote(null)
      try {
        const current = tableRef.current
        const result = await api.suggestEntityRegistryTable({
          rootTable: entityContext.rootTable,
          idColumn: entityContext.idColumn,
          tableName: trimmed,
          executionOrder: current.executionOrder,
        })
        const statusNote =
          result.note ?? (result.source === "catalog" ? "Suggested from FK graph." : null)

        if (tableSuggestionIsActionable(result.table)) {
          onChange?.(
            mergeTableSuggestion(
              { ...current, name: trimmed },
              { ...result.table, name: trimmed, executionOrder: current.executionOrder },
              touchedRef.current,
            ),
          )
          setSuggestNote(statusNote)
        } else {
          setSuggestNote(statusNote ?? "No schema suggestion available for this table.")
        }
      } catch {
        setSuggestNote(null)
      } finally {
        setSuggestBusy(false)
      }
    },
    [entityContext, onChange, readOnly],
  )

  function patchScope(scope: EntityRegistryTableScope): void {
    if (readOnly || !onChange) return
    markTouched("scope")
    onChange({ ...table, scope })
  }

  function updateTable(next: EntityRegistryTable): void {
    if (readOnly || !onChange) return
    onChange(next)
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Table name">
          <input
            value={table.name}
            onChange={(e) => updateTable({ ...table, name: e.target.value })}
            disabled={readOnly}
            className="input font-mono"
            placeholder="schema.TableName"
          />
        </Field>
        <Field label="Execution order">
          <input
            type="number"
            value={table.executionOrder}
            onChange={(e) => updateTable({ ...table, executionOrder: Number(e.target.value) || 0 })}
            disabled={readOnly}
            className="input"
          />
        </Field>
        <Field label="Scope kind">
          <Listbox
            value={table.scope.kind}
            options={SCOPE_KIND_OPTIONS}
            onChange={(kind) => {
              if (readOnly) return
              markTouched("scope")
              if (kind === "rootPk") patchScope({ kind, column: table.scope.kind === "rootPk" ? table.scope.column : "" })
              else patchScope({ kind: "sql", predicate: table.scope.kind === "sql" ? table.scope.predicate : "" })
            }}
            className="w-full"
            ariaLabel="Scope kind"
            disabled={readOnly}
          />
        </Field>
        <Field label="Source">
          <Listbox
            value={table.source ?? "manual"}
            options={SOURCE_OPTIONS}
            onChange={(source) => {
              markTouched("source")
              updateTable({ ...table, source })
            }}
            className="w-full"
            ariaLabel="Table source"
            disabled={readOnly}
          />
        </Field>
      </div>

      <div className="min-h-[7.5rem]">
        {table.scope.kind === "rootPk" && (
          <Field label="Root PK column">
            <input
              value={table.scope.column}
              onChange={(e) => {
                markTouched("scope")
                patchScope({ kind: "rootPk", column: e.target.value })
              }}
              disabled={readOnly}
              className="input font-mono"
            />
          </Field>
        )}

        {table.scope.kind === "sql" && (
          <Field label="SQL scope">
            <textarea
              value={table.scope.predicate}
              onChange={(e) => {
                markTouched("scope")
                patchScope({ kind: "sql", predicate: e.target.value })
              }}
              rows={5}
              disabled={readOnly}
              className="input font-mono text-sm"
              spellCheck={false}
              placeholder={"contractId = {id}\n-- or multi-hop:\nEXISTS (SELECT 1 FROM core.Dataset d WHERE d.contractId = {id} AND d.datasetId = core.Column.datasetId)"}
            />
            <p className="mt-1 text-xs text-text-muted">
              How rows in this table belong to the entity. Use {"{id}"} or {"{ids}"} for the entity key.
              Use &quot;Suggest from schema&quot; to auto-fill from the FK graph.
            </p>
          </Field>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Scope column">
          <input
            value={table.scopeColumn ?? ""}
            onChange={(e) => {
              markTouched("scopeColumn")
              updateTable({ ...table, scopeColumn: e.target.value || null })
            }}
            disabled={readOnly}
            className="input font-mono"
            placeholder="optional"
          />
        </Field>
        <Field label="Archive table">
          <input
            value={table.archiveTable ?? ""}
            onChange={(e) => {
              markTouched("archiveTable")
              updateTable({ ...table, archiveTable: e.target.value || null })
            }}
            disabled={readOnly}
            className="input font-mono"
            placeholder="optional"
          />
        </Field>
        <Field label="Default on">
          <Listbox
            value={table.enabledByDefault === false ? "no" : "yes"}
            options={[
              { value: "yes" as const, label: "Yes" },
              { value: "no" as const, label: "No" },
            ]}
            onChange={(value) => {
              markTouched("enabledByDefault")
              updateTable({ ...table, enabledByDefault: value === "yes" })
            }}
            className="w-full"
            ariaLabel="Enabled by default"
            disabled={readOnly}
          />
        </Field>
      </div>

      <Field label="Note">
        <textarea
          value={table.note ?? ""}
          onChange={(e) => {
            markTouched("note")
            updateTable({ ...table, note: e.target.value || null })
          }}
          rows={2}
          disabled={readOnly}
          className="input"
        />
      </Field>

      {!readOnly && entityContext?.rootTable && entityContext.idColumn && (
        <div className="flex flex-col items-end gap-1.5">
          <button
            type="button"
            disabled={suggestBusy || !table.name.trim()}
            onClick={() => void applySuggestion(table.name)}
            className="rounded border border-border-subtle px-2.5 py-1 text-sm text-text-muted hover:bg-overlay-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            {suggestBusy ? "Suggesting…" : "Suggest from schema"}
          </button>
          <p className="min-h-5 max-w-md text-right text-sm text-text-muted" aria-live="polite">
            {suggestBusy ? (
              <span className="inline-flex items-center justify-end gap-1">
                <Loader2 className="h-3 w-3 animate-spin" />
                Suggesting scope from schema…
              </span>
            ) : (
              suggestNote
            )}
          </p>
        </div>
      )}
    </div>
  )
}
