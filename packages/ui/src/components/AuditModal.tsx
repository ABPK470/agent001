/**
 * AuditModal — immutable audit log (admin session menu).
 */

import { ChevronDown, ChevronRight, Scale } from "lucide-react"
import { useState } from "react"
import { useIsMobile } from "../hooks/useIsMobile"
import { useStore } from "../store"
import { fmtTokens } from "../util"
import { ModalShell } from "../widgets/entity-registry/ModalShell"
import { modalViewerPanelClass } from "../widgets/entity-registry/modal-overlay"
import { ModalSearchField } from "./ModalSearchField"

export function AuditModal({ onClose }: { onClose: () => void }) {
  const isMobile = useIsMobile()
  const audit = useStore((s) => s.audit)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [filter, setFilter] = useState("")

  const filtered = filter
    ? audit.filter((a) => a.action.includes(filter) || a.actor.includes(filter))
    : audit

  return (
    <ModalShell
      title="Audit"
      subtitle="Immutable log of agent actions for the active session — tool calls, policy decisions, completions, and failures."
      icon={<Scale size={20} className="text-text-muted" />}
      onClose={onClose}
      widthClass={modalViewerPanelClass(isMobile)}
      footer={(
        <span className="text-[13px] text-text-muted">
          {filtered.length} {filtered.length === 1 ? "entry" : "entries"}
        </span>
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pb-4 pt-2">
        <ModalSearchField
          value={filter}
          onChange={setFilter}
          placeholder="Filter by action or actor…"
          aria-label="Filter audit log"
        />

        <div className="min-h-0 flex-1 overflow-y-auto show-scrollbar">
          {filtered.length === 0 ? (
            <div className="py-10 text-center text-sm text-text-muted">
              No audit entries yet. Start an agent run to populate the log.
            </div>
          ) : (
            <div className="space-y-0.5">
              {filtered.map((entry, i) => (
                <div key={`${entry.timestamp}:${entry.action}:${i}`}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-overlay-2"
                    onClick={() => setExpanded(expanded === i ? null : i)}
                  >
                    {Object.keys(entry.detail).length > 0 ? (
                      expanded === i
                        ? <ChevronDown size={14} className="shrink-0 text-text-muted" />
                        : <ChevronRight size={14} className="shrink-0 text-text-muted" />
                    ) : (
                      <span className="w-3.5 shrink-0" />
                    )}
                    <span className="w-[6.5rem] shrink-0 font-mono text-[13px] text-text-muted">
                      {entry.timestamp.slice(11, 23)}
                    </span>
                    <span className="w-14 shrink-0 text-text-secondary">{entry.actor}</span>
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
                      <span className="ml-auto shrink-0 font-mono text-[12px] text-text-muted">
                        {fmtTokens(entry.detail.totalTokens as number)} tk · {entry.detail.llmCalls as number} calls
                      </span>
                    )}
                  </button>

                  {expanded === i && Object.keys(entry.detail).length > 0 && (
                    <div className="mb-2 ml-8 rounded-xl border border-border-subtle bg-overlay-2 px-3 py-2 font-mono text-[13px] text-text-secondary">
                      {Object.entries(entry.detail).map(([k, v]) => (
                        <div key={k} className="flex gap-2">
                          <span className="shrink-0 text-text-muted">{k}:</span>
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
          )}
        </div>
      </div>
    </ModalShell>
  )
}
