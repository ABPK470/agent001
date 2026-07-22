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
  className,
  fill = false,
}: {
  sections: CatalogDiffSection[]
  openEntryKey: string | null
  onToggleEntry: (key: string | null) => void
  /** Collapse unchanged JSON lines inside each entry. */
  changesOnly?: boolean
  emptyMessage?: string
  className?: string
  /** Stretch open entry so the JSON diff consumes remaining modal height. */
  fill?: boolean
}): JSX.Element {
  if (sections.length === 0) {
    return (
      <p className={`px-6 py-6 text-sm text-text-muted ${className ?? ""}`.trim()}>
        {emptyMessage}
      </p>
    )
  }

  return (
    <ul
      className={[
        "min-h-0 flex-1 overflow-y-auto show-scrollbar px-6 py-4",
        fill ? "flex flex-col gap-3" : "space-y-3",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {sections.map((section) => {
        const entries = [...section.creates, ...section.updates, ...section.deletes]
        const holdsOpen = fill && entries.some(
          (entry) => catalogDiffEntryKey(section.section, entry) === openEntryKey,
        )
        return (
          <li
            key={section.section}
            className={[
              "rounded-lg border border-border-subtle p-3",
              holdsOpen ? "flex min-h-0 flex-1 flex-col" : "shrink-0",
            ].join(" ")}
          >
            <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
              <h4 className="text-sm font-medium text-text">{section.label}</h4>
              <span className="font-mono text-xs text-text-faint">
                +{section.creates.length} ~{section.updates.length} −{section.deletes.length}
              </span>
            </div>
            <div className={holdsOpen ? "flex min-h-0 flex-1 flex-col gap-2" : "space-y-2"}>
              {entries.map((entry) => {
                const key = catalogDiffEntryKey(section.section, entry)
                const open = openEntryKey === key
                return (
                  <DiffEntryCard
                    key={key}
                    entry={entry}
                    open={open}
                    changesOnly={changesOnly}
                    fill={fill && open}
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
  fill,
}: {
  entry: CatalogDiffEntry
  open: boolean
  onToggle: () => void
  changesOnly: boolean
  fill: boolean
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
    <div
      className={[
        "overflow-hidden rounded-md border border-border-subtle/80",
        fill ? "flex min-h-0 flex-1 flex-col" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full shrink-0 items-center gap-2 px-2.5 py-2 text-left hover:bg-elevated/40"
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
        <div
          className={[
            "border-t border-border-subtle p-2",
            fill ? "flex min-h-0 flex-1 flex-col" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <CatalogJsonDiff
            beforeJson={entry.beforeJson}
            afterJson={entry.afterJson}
            changesOnly={changesOnly}
            className={fill ? "min-h-0 flex-1 max-h-none h-full" : undefined}
          />
        </div>
      )}
    </div>
  )
}
