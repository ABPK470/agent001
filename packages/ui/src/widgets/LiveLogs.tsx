/**
 * LiveLogs — streaming log output from agent activity.
 *
 * Shows real-time events as they happen: tool calls, thinking, errors.
 * Auto-scrolls, with filter toggles by level.
 */

import { useEffect, useRef, useState } from "react"
import { useStore } from "../store"

const LEVEL_COLORS: Record<string, string> = {
  info: "var(--color-text-secondary)",
  thinking: "var(--color-accent)",
  error: "var(--color-error)",
  tool: "var(--color-success)",
}

const LEVEL_LABELS: Record<string, string> = {
  info: "INF",
  thinking: "THK",
  error: "ERR",
  tool: "TUL",
}

export function LiveLogs() {
  const logs = useStore((s) => s.logs)
  const [autoScroll, setAutoScroll] = useState(true)
  const [filter, setFilter] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const filtered = filter ? logs.filter((l) => l.level === filter) : logs

  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" })
    }
  }, [logs, autoScroll])

  function handleScroll() {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setAutoScroll(atBottom)
  }

  return (
    <div className="flex flex-col h-full gap-2">
      {/* Filters */}
      <div className="flex items-center gap-1 shrink-0">
        {[null, "info", "thinking", "error"].map((level) => (
          <button
            key={level ?? "all"}
            className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
              filter === level
                ? "bg-accent/20 text-accent"
                : "text-text-muted hover:text-text"
            }`}
            onClick={() => setFilter(level)}
          >
            {level ?? "All"}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-text-muted">{filtered.length}</span>
      </div>

      {/* Log entries */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto font-mono text-[11px] leading-relaxed space-y-px"
        onScroll={handleScroll}
      >
        {filtered.length === 0 && (
          <div className="text-text-muted text-center pt-8 font-sans text-[11px]">
            No logs yet
          </div>
        )}

        {filtered.map((log, i) => (
          <div key={i} className="flex gap-2 py-px hover:bg-elevated/50 px-1 rounded-sm">
            <span className="text-text-muted shrink-0 w-16 text-[10px]">
              {log.timestamp.slice(11, 23)}
            </span>
            <span
              className="shrink-0 w-6 text-[10px] font-medium"
              style={{ color: LEVEL_COLORS[log.level] ?? "var(--color-text-muted)" }}
            >
              {LEVEL_LABELS[log.level] ?? log.level.slice(0, 3).toUpperCase()}
            </span>
            <span className="text-text-secondary break-all">{log.message}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Scroll indicator */}
      {!autoScroll && (
        <button
          className="text-[10px] text-accent hover:text-accent-hover text-center"
          onClick={() => {
            setAutoScroll(true)
            bottomRef.current?.scrollIntoView({ behavior: "smooth" })
          }}
        >
          ↓ Scroll to bottom
        </button>
      )}
    </div>
  )
}
