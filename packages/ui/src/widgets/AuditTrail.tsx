/**
 * AuditTrail — immutable audit log table.
 *
 * Every agent action is logged: tool invocations, policy blocks,
 * completions, failures. Filterable and expandable.
 */

import { useState } from "react"
import { useStore } from "../store"

export function AuditTrail() {
  const audit = useStore((s) => s.audit)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [filter, setFilter] = useState("")

  const filtered = filter
    ? audit.filter((a) => a.action.includes(filter) || a.actor.includes(filter))
    : audit

  return (
    <div className="flex flex-col h-full gap-2">
      {/* Search */}
      <input
        className="bg-base border border-border rounded px-2 py-1 text-[11px] text-text placeholder:text-text-muted outline-none focus:border-accent transition-colors shrink-0"
        placeholder="Filter by action or actor..."
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {filtered.length === 0 && (
          <div className="text-text-muted text-[11px] text-center pt-8">
            No audit entries
          </div>
        )}

        <div className="space-y-px">
          {filtered.map((entry, i) => (
            <div key={i}>
              <div
                className="flex items-center gap-3 py-1.5 px-2 hover:bg-elevated/50 rounded-sm cursor-pointer text-[11px]"
                onClick={() => setExpanded(expanded === i ? null : i)}
              >
                <span className="text-text-muted font-mono text-[10px] w-16 shrink-0">
                  {entry.timestamp.slice(11, 23)}
                </span>
                <span className="text-text-secondary w-12 shrink-0">{entry.actor}</span>
                <span className={`font-medium ${
                  entry.action.includes("blocked") || entry.action.includes("denied")
                    ? "text-error"
                    : entry.action.includes("completed")
                    ? "text-success"
                    : entry.action.includes("failed")
                    ? "text-warning"
                    : "text-text"
                }`}>
                  {entry.action}
                </span>
              </div>

              {/* Expanded detail */}
              {expanded === i && Object.keys(entry.detail).length > 0 && (
                <div className="ml-8 mb-2 px-3 py-2 bg-base rounded border border-border text-[10px] font-mono text-text-secondary">
                  {Object.entries(entry.detail).map(([k, v]) => (
                    <div key={k} className="flex gap-2">
                      <span className="text-text-muted shrink-0">{k}:</span>
                      <span className="break-all">
                        {typeof v === "string" ? v : JSON.stringify(v)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="text-[10px] text-text-muted shrink-0">
        {filtered.length} entries
      </div>
    </div>
  )
}
