/**
 * IOE bottom panel components — Output, Audit, Feed, Problems.
 */

import { AlertTriangle } from "lucide-react"
import type { AuditEntry, LogEntry } from "../../types"
import { C, ts, type FeedItem, type Problem } from "./constants"

// ── OutputPanel (logs) ───────────────────────────────────────────

export function OutputPanel({ logs }: { logs: LogEntry[] }) {
  if (logs.length === 0) {
    return <div className="px-3 py-2" style={{ color: C.dim }}>No output</div>
  }
  return (
    <div className="px-3 py-1">
      {logs.slice(-200).map((log, i) => {
        const levelColor = log.level === "error" ? C.coral : log.level === "warn" ? C.warning : C.muted
        return (
          <div key={i} className="truncate">
            <span style={{ color: C.dim }}>[{ts(log.timestamp)}]</span>{" "}
            <span style={{ color: levelColor, textTransform: "uppercase" }}>{log.level.slice(0, 3)}</span>{" "}
            <span style={{ color: C.textSecondary }}>{log.message}</span>
          </div>
        )
      })}
    </div>
  )
}

// ── AuditPanel ───────────────────────────────────────────────────

export function AuditPanel({ audit }: { audit: AuditEntry[] }) {
  if (audit.length === 0) {
    return <div className="px-3 py-2" style={{ color: C.dim }}>No audit entries</div>
  }
  return (
    <div className="px-3 py-1">
      {audit.map((a, i) => {
        const actionColor = a.action.includes("blocked") || a.action.includes("denied")
          ? C.coral
          : a.action.includes("completed")
            ? C.success
            : a.action.includes("failed")
              ? C.warning
              : C.textSecondary
        return (
          <div key={i} className="truncate">
            <span style={{ color: C.dim }}>[{ts(a.timestamp)}]</span>{" "}
            <span style={{ color: C.accent }}>{a.actor}</span>{" "}
            <span style={{ color: actionColor }}>{a.action}</span>
            {Object.keys(a.detail).length > 0 && (
              <span style={{ color: C.dim }}> {JSON.stringify(a.detail).slice(0, 100)}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── FeedPanel ────────────────────────────────────────────────────

export function FeedPanel({ items }: { items: FeedItem[] }) {
  if (items.length === 0) {
    return <div className="px-3 py-1" style={{ color: C.dim }}>Awaiting activity</div>
  }
  return (
    <div className="px-3 py-1">
      {items.map((item, i) => (
        <div key={i} className="truncate" style={{ color: item.color }}>{item.text}</div>
      ))}
    </div>
  )
}

// ── ProblemsPanel ────────────────────────────────────────────────

export function ProblemsPanel({ problems }: { problems: Problem[] }) {
  if (problems.length === 0) {
    return <div className="px-3 py-2" style={{ color: C.success }}>No problems detected</div>
  }
  return (
    <div className="px-3 py-1">
      {problems.map((p, i) => (
        <div key={i} className="flex items-start gap-2 py-0.5">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" style={{ color: C.coral }} />
          <span className="text-[10px] shrink-0 uppercase w-12" style={{ color: C.dim }}>{p.source}</span>
          <span className="truncate" style={{ color: C.coral }}>{p.text}</span>
          {p.time && (
            <span className="ml-auto shrink-0" style={{ color: C.dim }}>{ts(p.time)}</span>
          )}
        </div>
      ))}
    </div>
  )
}
