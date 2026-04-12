/**
 * AuditTrail — immutable audit log table.
 *
 * Every agent action is logged: tool invocations, policy blocks,
 * completions, failures. Filterable and expandable.
 */

import { ChevronDown, ChevronRight, Search } from "lucide-react"
import { useState } from "react"
import { useStore } from "../store"
import { fmtTokens } from "../util"

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
      <div className="relative shrink-0">
        <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
        <input
          className="w-full bg-base rounded-lg pl-8 pr-3 py-1.5 text-sm text-text placeholder:text-text-muted outline-none focus:ring-1 focus:ring-accent transition-all"
          placeholder="Filter by action or actor..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="text-text-muted text-sm text-center pt-8">
            No audit entries
          </div>
        )}

        <div className="space-y-0.5">
          {filtered.map((entry, i) => (
            <div key={i}>
              <div
                className="flex items-center gap-3 py-1.5 px-2 hover:bg-elevated/40 rounded-lg cursor-pointer text-sm"
                onClick={() => setExpanded(expanded === i ? null : i)}
              >
                {Object.keys(entry.detail).length > 0 ? (
                  expanded === i
                    ? <ChevronDown size={14} className="text-text-muted shrink-0" />
                    : <ChevronRight size={14} className="text-text-muted shrink-0" />
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                <span className="text-text-muted font-mono text-[13px] w-[6.5rem] shrink-0">
                  {entry.timestamp.slice(11, 23)}
                </span>
                <span className="text-text-secondary w-14 shrink-0">{entry.actor}</span>
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
                {typeof entry.detail.totalTokens === "number" && entry.detail.totalTokens > 0 && (
                  <span className="ml-auto text-text-muted font-mono text-[12px] shrink-0">
                    {fmtTokens(entry.detail.totalTokens as number)} tk · {entry.detail.llmCalls as number} calls
                  </span>
                )}
              </div>

              {/* Expanded detail */}
              {expanded === i && Object.keys(entry.detail).length > 0 && (
                <div className="ml-8 mb-2 px-3 py-2 bg-base rounded-lg text-[13px] font-mono text-text-secondary">
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
      <div className="text-[13px] text-text-muted shrink-0">
        {filtered.length} entries
      </div>
    </div>
  )
}
