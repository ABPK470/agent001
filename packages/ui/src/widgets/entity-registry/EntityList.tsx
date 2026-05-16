/**
 * Entity list pane — left column of the EntityRegistry widget.
 *
 * Matches the visual vocabulary of EnvSync / OperationLog list panes:
 *  - panel background, subtle borders, hover/selected accent overlays
 *  - displayName + id + version on first line, root table on second
 *  - retired entities are dimmed and marked with a small tag
 */

import { Archive } from "lucide-react"
import type { JSX } from "react"
import type { EntityRegistryDefinition } from "../../types"

export interface EntityListProps {
  items: EntityRegistryDefinition[]
  selectedId: string | null
  onSelect: (id: string) => void
}

export function EntityList({ items, selectedId, onSelect }: EntityListProps): JSX.Element {
  if (items.length === 0) {
    return (
      <div className="p-4 text-xs text-text-muted">
        No entities yet. Use <span className="font-mono text-text">Re-seed</span> or{" "}
        <span className="font-mono text-text">Import YAML</span> in the toolbar.
      </div>
    )
  }
  return (
    <ul className="flex flex-col">
      {items.map((it) => {
        const active = selectedId === it.id
        const retired = it.retiredAt != null
        return (
          <li key={it.id}>
            <button
              type="button"
              onClick={() => onSelect(it.id)}
              className={[
                "flex w-full flex-col items-start gap-0.5 border-b border-border-subtle px-3 py-2 text-left text-xs transition-colors",
                active
                  ? "bg-accent-soft text-text"
                  : "text-text hover:bg-overlay-2",
                retired ? "opacity-60" : "",
              ].join(" ")}
            >
              <div className="flex w-full items-center gap-2">
                <span className="font-medium truncate">{it.displayName}</span>
                {retired && (
                  <span className="ml-auto flex items-center gap-1 rounded-sm bg-overlay-2 px-1 py-px text-[10px] text-text-muted">
                    <Archive className="h-2.5 w-2.5" /> retired
                  </span>
                )}
              </div>
              <span className="text-text-muted">
                <span className="font-mono">{it.id}</span> · v{it.version} · {it.tables.length} tbl
              </span>
              <span className="text-[10px] font-mono text-text-faint truncate w-full">{it.rootTable}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
