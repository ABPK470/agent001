/**
 * Compact table list — summary metadata when collapsed; structured drawer when expanded.
 */

import { Check, ChevronDown, Minus, X } from "lucide-react"
import { useMemo, useState, type JSX } from "react"
import { CodeBlock } from "../../components/CodeBlock"
import {
  AccordionBoolPill,
  AccordionDetailBlock,
  AccordionMetaField,
  AccordionMetaGrid,
} from "./entity-accordion-detail"
import type { EntityRegistryTable } from "../../types"
import {
  sortedTables,
  tableScopeSubtitle,
  tableSourceLabel,
} from "./entity-overview-helpers"

function DefaultOnIndicator({ enabled }: { enabled: boolean | null | undefined }): JSX.Element {
  if (enabled === true) {
    return <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-label="Enabled by default" />
  }
  if (enabled === false) {
    return <X className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-label="Disabled by default" />
  }
  return <Minus className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden />
}

export function EntityTableDetail({ table }: { table: EntityRegistryTable }): JSX.Element {
  return (
    <div className="entity-accordion-detail">
      <AccordionDetailBlock title="Properties">
        <AccordionMetaGrid>
          <AccordionMetaField label="Table" value={table.name} mono />
          <AccordionMetaField label="Scope column" value={table.scopeColumn} mono />
          <AccordionMetaField label="Order" value={table.executionOrder} />
          <AccordionMetaField
            label="Scope"
            value={table.scope.kind === "rootPk" ? `rootPk · ${table.scope.column}` : "sql scope"}
          />
          <AccordionMetaField label="Source" value={tableSourceLabel(table.source)} />
          <AccordionMetaField label="Archive table" value={table.archiveTable} mono />
          <AccordionMetaField label="Default on" value={<AccordionBoolPill value={table.enabledByDefault} />} />
          <AccordionMetaField label="User controllable" value={<AccordionBoolPill value={table.userControllable} />} />
        </AccordionMetaGrid>
      </AccordionDetailBlock>

      {table.scope.kind === "sql" && table.scope.predicate.trim() && (
        <AccordionDetailBlock title="SQL scope expression">
          <CodeBlock
            code={table.scope.predicate.trim()}
            lang="sql"
            embedded
            maxHeight={220}
            label="SQL scope"
          />
        </AccordionDetailBlock>
      )}

      {table.note?.trim() && (
        <AccordionDetailBlock title="Note">
          <p className="entity-accordion-detail__prose">{table.note.trim()}</p>
        </AccordionDetailBlock>
      )}
    </div>
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
        "entity-accordion__item",
        expanded ? "entity-accordion__item--expanded" : "",
        note ? "entity-accordion__item--noted" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="entity-accordion__header"
      >
        <span className="entity-accordion__index">{table.executionOrder}</span>
        <span className="entity-accordion__main">
          <span className="entity-accordion__name">{table.name}</span>
          <span className="entity-accordion__subtitle">{tableScopeSubtitle(table)}</span>
        </span>
        <span className="entity-accordion__meta">
          <span className="entity-accordion__badge">{tableSourceLabel(table.source)}</span>
          <span className="entity-accordion__status">
            <DefaultOnIndicator enabled={table.enabledByDefault} />
          </span>
          <ChevronDown
            className={[
              "entity-accordion__chevron",
              expanded ? "entity-accordion__chevron--open" : "",
            ].join(" ")}
            aria-hidden
          />
        </span>
      </button>

      {expanded && (
        <div className="entity-accordion__panel">
          <EntityTableDetail table={table} />
        </div>
      )}
    </li>
  )
}

export interface EntityTablesExplorerProps {
  tables: EntityRegistryTable[]
  emptyMessage?: string
  /** Nested inside Overview accordion — no second outer frame. */
  embedded?: boolean
}

export function EntityTablesExplorer({
  tables,
  emptyMessage = "No tables in this definition.",
  embedded = false,
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
    <ol className={`entity-accordion-list${embedded ? " entity-accordion-list--embedded" : ""}`}>
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
