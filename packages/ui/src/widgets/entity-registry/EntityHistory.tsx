/**
 * History tab — version timeline with structured per-edit diffs.
 * Mirrors the visual rhythm of EnvSync's history modal.
 */

import { Clock, GitCommitVertical, User } from "lucide-react"
import type { JSX } from "react"
import type { EntityRegistryHistoryEntry } from "../../types"
import { timeAgo } from "../../util"

export interface EntityHistoryProps {
  entries: EntityRegistryHistoryEntry[]
}

export function EntityHistory({ entries }: EntityHistoryProps): JSX.Element {
  if (entries.length === 0) {
    return <div className="text-xs text-text-muted">No history yet.</div>
  }
  return (
    <ol className="relative space-y-3 border-l border-border-subtle pl-5">
      {entries.map((e) => (
        <li key={e.version} className="relative">
          <span className="absolute -left-[26px] top-1 flex h-4 w-4 items-center justify-center rounded-full bg-panel-2 ring-1 ring-border-subtle">
            <GitCommitVertical className="h-2.5 w-2.5 text-accent" />
          </span>
          <div className="rounded-lg border border-border-subtle bg-panel p-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono font-semibold text-text">v{e.version}</span>
              {e.versionLabel && (
                <span className="rounded bg-accent-soft px-1.5 py-px text-[10px] text-accent">
                  {e.versionLabel}
                </span>
              )}
              <span className="flex items-center gap-1 text-text-muted">
                <User className="h-3 w-3" /> {e.createdBy}
              </span>
              <span className="flex items-center gap-1 text-text-muted">
                <Clock className="h-3 w-3" /> {timeAgo(e.createdAt)}
              </span>
            </div>
            <div className="mt-1 text-[11px] text-text-muted">
              Reason: <span className="text-text">{e.reason || "—"}</span>
            </div>
            {e.diff.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-[11px]">
                {e.diff.map((d, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="font-mono text-accent shrink-0">{d.kind}</span>
                    {d.tableName && <span className="font-mono text-text-muted shrink-0">{d.tableName}</span>}
                    <span className="text-text">{d.description}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </li>
      ))}
    </ol>
  )
}
