/**
 * History tab — version timeline.
 */

import { Clock, History, User } from "lucide-react"
import type { JSX } from "react"
import { EmptyState } from "../../components/EmptyState"
import type { EntityRegistryHistoryEntry } from "../../types"
import { timeAgo } from "../../util"
import { PANEL } from "./chrome"

export interface EntityHistoryProps {
  entries: EntityRegistryHistoryEntry[]
}

export function EntityHistory({ entries }: EntityHistoryProps): JSX.Element {
  if (entries.length === 0) {
    return <EmptyState icon={History} message="No history yet." className="min-h-[12rem] py-8" />
  }
  return (
    <ol className={PANEL}>
      {entries.map((e, index) => (
        <li
          key={e.version}
          className={[
            "px-3 py-2.5 text-xs",
            index < entries.length - 1 ? "border-b border-border/20" : "",
          ].join(" ")}
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono font-semibold text-text">rev {e.version}</span>
            <span className="flex items-center gap-1 text-text-muted">
              <User className="h-3 w-3" /> {e.createdBy}
            </span>
            <span className="flex items-center gap-1 text-text-muted">
              <Clock className="h-3 w-3" /> {timeAgo(e.createdAt)}
            </span>
          </div>
          {e.reason && (
            <p className="mt-1 text-sm text-text-muted">{e.reason}</p>
          )}
          {e.diff.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-sm text-text-muted">
              {e.diff.map((d, i) => (
                <li key={i} className="flex gap-2">
                  <span className="shrink-0 font-mono text-accent">{d.kind}</span>
                  {d.tableName && <span className="shrink-0 font-mono">{d.tableName}</span>}
                  <span>{d.description}</span>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  )
}
