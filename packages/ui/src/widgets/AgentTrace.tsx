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
        <div className="text-text-muted text-[13px] font-mono pt-3 pb-0.5 border-t border-text-muted/20 mt-2 flex items-center gap-2">
          <span className="text-text-muted/60">──</span>
          <span>iteration {entry.current}/{entry.max}</span>
          <span className="text-text-muted/60">──</span>
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

    case "delegation-start":
      return (
        <div className="py-1 pl-3 border-l-2 border-[#6CB4EE]/40 mt-1">
          <div className="flex items-center gap-2">
            <span className="text-[#6CB4EE] text-[13px] font-medium font-mono">DLGT</span>
            <span className="text-[#6CB4EE]/70 text-[13px]">▶</span>
            {entry.agentName && (
              <span className="text-text-secondary text-[13px] font-medium">[{entry.agentName}]</span>
            )}
            <span className="text-text-muted text-[12px]">depth {entry.depth}</span>
          </div>
          <div className="text-text-secondary text-sm mt-0.5 ml-5">
            {entry.goal.length > 200 ? entry.goal.slice(0, 200) + "..." : entry.goal}
          </div>
          <div className="text-text-muted/50 text-[11px] font-mono mt-0.5 ml-5">
            tools: {entry.tools.slice(0, 6).join(", ")}{entry.tools.length > 6 ? ` +${entry.tools.length - 6}` : ""}
          </div>
        </div>
      )

    case "delegation-iteration":
      return (
        <div className="text-text-muted/50 text-[12px] font-mono pl-6 py-0.5">
          ↳ child iteration {entry.iteration}/{entry.maxIterations}
        </div>
      )

    case "delegation-end":
      return (
        <div className="py-1 pl-3 border-l-2 border-[#6CB4EE]/40 mb-1">
          <div className="flex items-center gap-2">
            <span className="text-[#6CB4EE] text-[13px] font-medium font-mono">DLGT</span>
            <span className={`text-[13px] ${entry.status === "done" ? "text-success" : "text-error"}`}>◀ {entry.status}</span>
            <span className="text-text-muted text-[12px]">depth {entry.depth}</span>
          </div>
          {entry.answer && (
            <div
              className="text-text-secondary text-sm mt-0.5 ml-5 cursor-pointer"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? entry.answer : (entry.answer.length > 150 ? entry.answer.slice(0, 150) + "..." : entry.answer)}
            </div>
          )}
          {entry.error && (
            <div className="text-error/80 text-sm mt-0.5 ml-5">{entry.error}</div>
          )}
        </div>
      )

    // ── Planner events ───────────────────────────────────────────
    case "planner-decision":
      return (
        <div className="py-1 pl-3 border-l-2 border-[#C084FC]/40 mt-1">
          <div className="flex items-center gap-2">
            <span className="text-[#C084FC] text-[13px] font-medium font-mono">PLAN</span>
            <span className={`text-[13px] ${entry.shouldPlan ? "text-[#C084FC]" : "text-text-muted"}`}>
              {entry.shouldPlan ? "▶ activating planner" : "▷ skipped"}
            </span>
            <span className="text-text-muted text-[11px] font-mono">score {entry.score.toFixed(2)}</span>
          </div>
          <div className="text-text-muted text-[12px] mt-0.5 ml-5">{entry.reason}</div>
        </div>
      )

    case "planner-generating":
      return (
        <div className="text-[#C084FC]/60 text-[12px] font-mono pl-6 py-0.5">
          ⟳ generating plan…
        </div>
      )

    case "planner-plan-generated":
      return (
        <div className="py-1 pl-3 border-l-2 border-[#C084FC]/40">
          <div className="flex items-center gap-2">
            <span className="text-[#C084FC] text-[13px] font-medium font-mono">PLAN</span>
            <span className="text-[#C084FC]/70 text-[13px]">✓ {entry.stepCount} steps</span>
          </div>
          <div className="text-text-muted text-[12px] mt-0.5 ml-5">{entry.reason}</div>
          <div className="text-text-muted/50 text-[11px] font-mono mt-0.5 ml-5">
            {entry.steps.map(s => s.name).join(" → ")}
          </div>
        </div>
      )

    case "planner-generation-failed":
    case "planner-validation-failed":
      return (
        <div className="py-1 pl-3 border-l-2 border-error/40">
          <div className="flex items-center gap-2">
            <span className="text-[#C084FC] text-[13px] font-medium font-mono">PLAN</span>
            <span className="text-error text-[13px]">✗ {entry.kind === "planner-generation-failed" ? "generation" : "validation"} failed</span>
          </div>
          {entry.diagnostics.map((d, i) => (
            <div key={i} className="text-error/70 text-[12px] ml-5 mt-0.5">
              [{d.code}] {d.message}
            </div>
          ))}
        </div>
      )

    case "planner-pipeline-start":
      return (
        <div className="text-[#C084FC]/70 text-[12px] font-mono pl-6 py-0.5 border-t border-[#C084FC]/10 mt-1">
          ▶ pipeline attempt {entry.attempt}/{entry.maxRetries}
        </div>
      )

    case "planner-step-start":
      return (
        <div className="text-text-muted text-[12px] font-mono pl-6 py-0.5">
          ⟩ {entry.stepName} <span className="text-text-muted/50">({entry.stepType})</span>
        </div>
      )

    case "planner-step-end":
      return (
        <div className="text-[12px] font-mono pl-6 py-0.5">
          <span className={entry.status === "done" ? "text-success" : "text-error"}>
            {entry.status === "done" ? "✓" : "✗"} {entry.stepName}
          </span>
          <span className="text-text-muted/50 ml-2">{entry.durationMs}ms</span>
        </div>
      )

    case "planner-pipeline-end":
      return (
        <div className="py-1 pl-3 border-l-2 border-[#C084FC]/40 mb-1">
          <div className="flex items-center gap-2">
            <span className="text-[#C084FC] text-[13px] font-medium font-mono">PIPE</span>
            <span className={`text-[13px] ${entry.status === "done" ? "text-success" : "text-error"}`}>
              ◀ {entry.status}
            </span>
            <span className="text-text-muted text-[12px]">{entry.completedSteps}/{entry.totalSteps} steps</span>
          </div>
        </div>
      )

    case "planner-verification":
      return (
        <div className="py-1 pl-3 border-l-2 border-[#C084FC]/40">
          <div className="flex items-center gap-2">
            <span className="text-[#C084FC] text-[13px] font-medium font-mono">VRFY</span>
            <span className={`text-[13px] ${entry.overall === "pass" ? "text-success" : entry.overall === "partial" ? "text-warning" : "text-error"}`}>
              {entry.overall}
            </span>
            <span className="text-text-muted text-[11px] font-mono">confidence {(entry.confidence * 100).toFixed(0)}%</span>
          </div>
          {entry.steps.filter(s => s.issues.length > 0).map((s, i) => (
            <div key={i} className="text-text-muted/60 text-[11px] ml-5 mt-0.5">
              {s.stepName}: {s.issues.join("; ")}
            </div>
          ))}
        </div>
      )

    case "planner-retry":
      return (
        <div className="text-warning text-[12px] font-mono pl-6 py-0.5">
          ↻ retry attempt {entry.attempt}: {entry.reason}
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
