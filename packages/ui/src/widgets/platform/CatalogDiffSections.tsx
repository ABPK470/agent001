/**
 * Expandable catalog snapshot diff sections — shared by version detail + Publish.
 */

import { ChevronDown, ChevronRight } from "lucide-react"
import type { JSX } from "react"
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
}: {
  sections: CatalogDiffSection[]
  openEntryKey: string | null
  onToggleEntry: (key: string | null) => void
  /** Collapse unchanged JSON lines inside each entry. */
  changesOnly?: boolean
  emptyMessage?: string
}): JSX.Element {
  if (sections.length === 0) {
    return <p className="px-4 py-6 text-sm text-text-muted">{emptyMessage}</p>
  }

  return (
    <ul className="min-h-0 flex-1 space-y-3 overflow-y-auto show-scrollbar p-4">
      {sections.map((section) => {
        const entries = [...section.creates, ...section.updates, ...section.deletes]
        return (
          <li key={section.section} className="rounded-lg border border-border-subtle p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h4 className="text-sm font-medium text-text">{section.label}</h4>
              <span className="font-mono text-xs text-text-faint">
                +{section.creates.length} ~{section.updates.length} −{section.deletes.length}
              </span>
            </div>
            <div className="space-y-2">
              {entries.map((entry) => {
                const key = catalogDiffEntryKey(section.section, entry)
                const open = openEntryKey === key
                return (
                  <DiffEntryCard
                    key={key}
                    entry={entry}
                    open={open}
                    changesOnly={changesOnly}
                    onToggle={() => onToggleEntry(open ? null : key)}
                  />
                )
              })}
            </div>
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
}: {
  entry: CatalogDiffEntry
  open: boolean
  onToggle: () => void
  changesOnly: boolean
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
      >
        {open ? (
          <ChevronDown size={14} className="shrink-0 text-text-faint" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-text-faint" />
        )}
        <span className={`text-[10px] font-semibold uppercase tracking-wider ${tone}`}>{label}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-text">{entry.id}</span>
        {entry.changedPaths.length > 0 && (
          <span className="hidden max-w-[40%] truncate text-xs text-text-faint sm:inline">
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
          />
        </div>
      )}
    </div>
  )
}
