/**
 * Expandable catalog snapshot diff sections — shared by version detail + Publish.
 *
 * Section headers collapse their entry lists. Entry rows expand JSON in place.
 * Only one JSON pane is open at a time (keeps the modal usable for large payloads).
 */

import { ChevronDown, ChevronRight } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useState } from "react"
import { CatalogJsonDiff } from "./CatalogJsonDiff"

export type CatalogDiffEntry = {
  id: string
  kind: "create" | "update" | "delete"
  changedPaths: string[]
  beforeJson: string | null
  afterJson: string | null
}

export type CatalogDiffSection = {
  section: string
  label: string
  creates: CatalogDiffEntry[]
  updates: CatalogDiffEntry[]
  deletes: CatalogDiffEntry[]
}

export function catalogDiffEntryKey(sectionId: string, entry: CatalogDiffEntry): string {
  return `${sectionId}:${entry.kind}:${entry.id}`
}

export function firstCatalogDiffEntryKey(sections: CatalogDiffSection[]): string | null {
  for (const section of sections) {
    const entry = section.creates[0] ?? section.updates[0] ?? section.deletes[0]
    if (entry) return catalogDiffEntryKey(section.section, entry)
  }
  return null
}

export function CatalogDiffSections({
  sections,
  openEntryKey,
  onToggleEntry,
  changesOnly = false,
  emptyMessage = "No differences in this comparison.",
  className,
  /** Taller JSON pane when an entry is expanded (Publish modal). */
  fill = false,
}: {
  sections: CatalogDiffSection[]
  openEntryKey: string | null
  onToggleEntry: (key: string | null) => void
  /** Collapse unchanged JSON lines inside each entry. */
  changesOnly?: boolean
  emptyMessage?: string
  className?: string
  fill?: boolean
}): JSX.Element {
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    setCollapsedSections(new Set())
  }, [sections])

  if (sections.length === 0) {
    return (
      <p className={`px-6 py-6 text-sm text-text-muted ${className ?? ""}`.trim()}>
        {emptyMessage}
      </p>
    )
  }

  const jsonMaxClass = fill ? "max-h-96" : "max-h-80"

  function toggleSection(sectionId: string): void {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(sectionId)) next.delete(sectionId)
      else next.add(sectionId)
      return next
    })
  }

  return (
    <ul
      className={[
        "min-h-0 flex-1 space-y-3 overflow-y-auto show-scrollbar px-6 py-4",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {sections.map((section) => {
        const entries = [...section.creates, ...section.updates, ...section.deletes]
        const sectionCollapsed = collapsedSections.has(section.section)
        return (
          <li
            key={section.section}
            className="shrink-0 rounded-lg border border-border-subtle"
          >
            <button
              type="button"
              onClick={() => toggleSection(section.section)}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-elevated/40"
              aria-expanded={!sectionCollapsed}
            >
              {sectionCollapsed ? (
                <ChevronRight size={14} className="shrink-0 text-text-faint" />
              ) : (
                <ChevronDown size={14} className="shrink-0 text-text-faint" />
              )}
              <h4 className="min-w-0 flex-1 text-sm font-medium text-text">{section.label}</h4>
              <span className="shrink-0 font-mono text-xs tabular-nums text-text-faint">
                +{section.creates.length} ~{section.updates.length} −{section.deletes.length}
              </span>
            </button>
            {!sectionCollapsed && (
              <div className="space-y-2 border-t border-border-subtle px-3 py-2.5">
                {entries.length === 0 ? (
                  <p className="px-1 py-1 text-xs text-text-muted">No entry-level changes.</p>
                ) : (
                  entries.map((entry) => {
                    const key = catalogDiffEntryKey(section.section, entry)
                    const open = openEntryKey === key
                    return (
                      <DiffEntryCard
                        key={key}
                        entry={entry}
                        open={open}
                        changesOnly={changesOnly}
                        jsonMaxClass={jsonMaxClass}
                        onToggle={() => onToggleEntry(open ? null : key)}
                      />
                    )
                  })
                )}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function DiffEntryCard({
  entry,
  open,
  onToggle,
  changesOnly,
  jsonMaxClass,
}: {
  entry: CatalogDiffEntry
  open: boolean
  onToggle: () => void
  changesOnly: boolean
  jsonMaxClass: string
}): JSX.Element {
  const tone =
    entry.kind === "create"
      ? "text-success"
      : entry.kind === "delete"
        ? "text-error"
        : "text-warning"
  const label =
    entry.kind === "create" ? "Added" : entry.kind === "delete" ? "Removed" : "Changed"

  return (
    <div className="overflow-hidden rounded-md border border-border-subtle/80">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-elevated/40"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown size={14} className="shrink-0 text-text-faint" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-text-faint" />
        )}
        <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-wider ${tone}`}>
          {label}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-text">{entry.id}</span>
        {entry.changedPaths.length > 0 && (
          <span className="hidden max-w-[40%] shrink-0 truncate text-xs text-text-faint sm:inline">
            {entry.changedPaths.slice(0, 4).join(", ")}
            {entry.changedPaths.length > 4 ? ` +${entry.changedPaths.length - 4}` : ""}
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-border-subtle p-2">
          <CatalogJsonDiff
            beforeJson={entry.beforeJson}
            afterJson={entry.afterJson}
            changesOnly={changesOnly}
            className={`${jsonMaxClass} overflow-auto`}
          />
        </div>
      )}
    </div>
  )
}
