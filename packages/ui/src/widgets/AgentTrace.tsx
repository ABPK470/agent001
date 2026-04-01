/**
 * AgentTrace — rich execution trace showing the agent's ReAct loop.
 *
 * Mirrors the terminal output: iterations, tool calls with args/results,
 * thinking steps, and the final answer — formatted for the dashboard.
 */

import { ArrowDown } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useStore } from "../store"
import type { TraceEntry } from "../types"
import { fmtTokens } from "../util"

function TraceItem({ entry }: { entry: TraceEntry }) {
  const [expanded, setExpanded] = useState(false)

  switch (entry.kind) {
    case "goal":
      return (
        <div className="pt-2 pb-1">
          <span className="text-accent font-semibold text-sm">GOAL</span>
          <span className="text-text ml-2 text-sm">{entry.text}</span>
        </div>
      )

    case "iteration":
      return (
        <div className="text-text-muted text-[13px] font-mono pt-2 pb-0.5 border-t border-elevated/50 mt-1">
          iteration {entry.current}/{entry.max}
        </div>
      )

    case "thinking":
      return (
        <div className="py-0.5 pl-3 border-l-2 border-accent/30">
          <span className="text-accent text-[13px] font-medium">THK</span>
          <span className="text-text-secondary text-sm ml-2 whitespace-pre-wrap">{entry.text}</span>
        </div>
      )

    case "tool-call":
      return (
        <div className="py-1">
          <div
            className="flex items-center gap-2 cursor-pointer"
            onClick={() => setExpanded(!expanded)}
          >
            <span className="text-warning text-[13px] font-medium font-mono">CALL</span>
            <span className="text-text text-sm font-medium font-mono">{entry.tool}</span>
            {!expanded && entry.argsSummary && (
              <span className="text-text-muted text-[13px] font-mono truncate">{entry.argsSummary}</span>
            )}
          </div>
          {expanded && (
            <pre className="text-[13px] font-mono text-text-secondary bg-base rounded-lg p-2 mt-1 max-h-40 overflow-auto whitespace-pre-wrap">
              {entry.argsFormatted}
            </pre>
          )}
        </div>
      )

    case "tool-result":
      return (
        <div className="py-0.5 pl-3">
          <div
            className="flex items-center gap-2 cursor-pointer"
            onClick={() => setExpanded(!expanded)}
          >
            <span className="text-success text-[13px] font-medium font-mono">RSLT</span>
            {!expanded && (
              <span className="text-text-muted text-[13px] font-mono truncate">
                {entry.text.length > 120 ? entry.text.slice(0, 120) + "..." : entry.text}
              </span>
            )}
          </div>
          {expanded && (
            <pre className="text-[13px] font-mono text-text-secondary bg-base rounded-lg p-2 mt-1 max-h-40 overflow-auto whitespace-pre-wrap">
              {entry.text}
            </pre>
          )}
        </div>
      )

    case "tool-error":
      return (
        <div className="py-0.5 pl-3">
          <span className="text-error text-[13px] font-medium font-mono">ERR</span>
          <span className="text-error/80 text-sm ml-2">{entry.text}</span>
        </div>
      )

    case "answer":
      return (
        <div className="pt-2 pb-1 border-t border-elevated/50 mt-1">
          <div className="text-success font-semibold text-sm mb-1">COMPLETED</div>
          <div className="text-text-secondary text-sm whitespace-pre-wrap leading-relaxed">{entry.text}</div>
        </div>
      )

    case "error":
      return (
        <div className="pt-2 pb-1 border-t border-elevated/50 mt-1">
          <span className="text-error font-semibold text-sm">FAILED</span>
          <span className="text-error/80 text-sm ml-2">{entry.text}</span>
        </div>
      )

    case "usage":
      return (
        <div className="flex items-center gap-3 py-0.5 text-[12px] font-mono text-text-muted/60">
          <span>+{fmtTokens(entry.iterationTokens)} tk</span>
          <span className="text-text-muted/30">│</span>
          <span>total {fmtTokens(entry.totalTokens)}</span>
          <span className="text-text-muted/30">│</span>
          <span>{entry.llmCalls} calls</span>
        </div>
      )

    default:
      return null
  }
}

export function AgentTrace() {
  const trace = useStore((s) => s.trace)
  const [autoScroll, setAutoScroll] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" })
    }
  }, [trace, autoScroll])

  function handleScroll() {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setAutoScroll(atBottom)
  }

  return (
    <div className="flex flex-col h-full gap-2">
      {/* Header */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-[13px] text-text-muted ml-auto">{trace.length} entries</span>
      </div>

      {/* Trace entries */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto space-y-0 px-1"
        onScroll={handleScroll}
      >
        {trace.length === 0 && (
          <div className="text-text-muted text-center pt-8 text-sm">
            No trace yet — start an agent run
          </div>
        )}

        {trace.map((entry, i) => (
          <TraceItem key={i} entry={entry} />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Scroll indicator */}
      {!autoScroll && (
        <button
          className="flex items-center justify-center gap-1.5 text-[13px] text-accent hover:text-accent-hover shrink-0"
          onClick={() => {
            setAutoScroll(true)
            bottomRef.current?.scrollIntoView({ behavior: "smooth" })
          }}
        >
          <ArrowDown size={14} />
          New entries
        </button>
      )}
    </div>
  )
}
