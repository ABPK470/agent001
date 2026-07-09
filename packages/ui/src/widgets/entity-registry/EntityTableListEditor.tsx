import { ChevronRight, Plus, Trash2 } from "lucide-react"
import { useState, type JSX } from "react"
import type { EntityRegistryTable } from "../../types"
import { renumberEntityRegistryTables } from "../../types"
import { PANEL, TEXT_BTN } from "./chrome"
import { cloneEntityTable, effectiveTableSource, newEntityTable, normalizeEntityTable } from "./entity-edit-form"
import { EntityTableFields } from "./EntityTableFields"
import { ModalShell } from "./ModalShell"

export interface EntityTableListEditorProps {
  tables: EntityRegistryTable[]
  onTables: (tables: EntityRegistryTable[]) => void
  entityContext?: { rootTable: string; idColumn: string } | null
}

function scopeHint(table: EntityRegistryTable): string {
  switch (table.scope.kind) {
    case "rootPk":
      return `rootPk · ${table.scope.column || "—"}`
    case "sql":
      return "sql scope"
  }
}

export function EntityTableListEditor({ tables, onTables, entityContext }: EntityTableListEditorProps): JSX.Element {
  const sorted = [...tables].sort((a, b) => a.executionOrder - b.executionOrder)
  const [viewIndex, setViewIndex] = useState<number | null>(null)
  const [draftTable, setDraftTable] = useState<EntityRegistryTable | null>(null)

  function closeView(): void {
    setViewIndex(null)
    setDraftTable(null)
  }

  function openView(index: number): void {
    const table = sorted[index]
    if (!table) return
    setViewIndex(index)
    setDraftTable(normalizeEntityTable(cloneEntityTable(table)))
  }

  function addTable(): void {
    const nextOrder = sorted.length === 0 ? 1 : Math.max(...sorted.map((t) => t.executionOrder)) + 1
    const created = newEntityTable(nextOrder)
    const next = renumberEntityRegistryTables([...sorted, created])
    onTables(next)
    const createdIndex = next.length - 1
    setViewIndex(createdIndex)
    setDraftTable(normalizeEntityTable(cloneEntityTable(next[createdIndex]!)))
  }

  function removeTable(index: number): void {
    onTables(renumberEntityRegistryTables(sorted.filter((_, i) => i !== index)))
    if (viewIndex === index) closeView()
    else if (viewIndex !== null && viewIndex > index) setViewIndex(viewIndex - 1)
  }

  function saveView(): void {
    if (viewIndex === null || !draftTable) return
    const next = renumberEntityRegistryTables([
      ...sorted.slice(0, viewIndex),
      normalizeEntityTable(draftTable),
      ...sorted.slice(viewIndex + 1),
    ])
    onTables(next)
    closeView()
  }

  return (
    <>
      {sorted.length === 0 ? (
        <p className="text-sm text-text-muted">No tables yet. Add one here or edit the Source YAML.</p>
      ) : (
        <ol className={PANEL}>
          {sorted.map((table, index) => (
            <li key={`${table.name}-${table.executionOrder}-${index}`} className="border-b border-border-subtle last:border-b-0">
              <div className="flex items-stretch">
                <button
                  type="button"
                  onClick={() => openView(index)}
                  className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-elevated/50"
                >
                  <span className="w-5 shrink-0 text-right font-mono text-sm tabular-nums text-text-faint">
                    {table.executionOrder}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs font-medium text-text">
                      {table.name || "Untitled table"}
                    </span>
                    <span className="mt-0.5 block truncate text-sm text-text-muted">
                      {scopeHint(table)}
                    </span>
                  </span>
                  <span className="shrink-0 rounded border border-border-subtle bg-panel px-1.5 py-0.5 font-mono text-xs text-text-muted">
                    {effectiveTableSource(table.source)}
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-faint" />
                </button>
                <button
                  type="button"
                  onClick={() => removeTable(index)}
                  className="flex shrink-0 items-center border-l border-border-subtle px-2 text-text-muted transition-colors hover:bg-elevated hover:text-rose-400"
                  title="Remove table"
                  aria-label={`Remove table ${index + 1}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}

      <button type="button" onClick={addTable} className={`${TEXT_BTN} mt-3`}>
        <Plus className="h-3.5 w-3.5" />
        Add table
      </button>

      {draftTable && viewIndex !== null && (
        <ModalShell
          title={draftTable.name || `Table ${viewIndex + 1}`}
          subtitle={`order ${draftTable.executionOrder} · edit table`}
          size="focus"
          stackLevel={1}
          onClose={closeView}
          footer={(
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={closeView}
                className="rounded border border-border-subtle px-3 py-1.5 text-xs text-text-muted hover:bg-overlay-2 hover:text-text"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={saveView}
                className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-text-on-accent hover:bg-accent-hover"
              >
                Save table
              </button>
            </div>
          )}
        >
          <div className="entity-registry flex min-h-0 flex-1 flex-col overflow-auto p-5">
            <EntityTableFields
              table={draftTable}
              onChange={setDraftTable}
              entityContext={entityContext}
            />
          </div>
        </ModalShell>
      )}
    </>
  )
}
