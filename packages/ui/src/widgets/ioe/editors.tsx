/**
 * IOE editor-area panels — Trace, DAG, Timeline, Details, EditorTabs.
 */

import { Fragment, useEffect, useRef, useState } from "react"
import type { Run, Step, TraceEntry } from "../../types"
import { truncate } from "../../util"
import {
    C,
    dur,
    fmtK,
    statusDot,
    ts,
    type DagNode,
    type EditorTab,
    type UsageData,
} from "./constants"
import { KV } from "./primitives"

// ── EditorTabs — tab bar for the editor area ─────────────────────

export function EditorTabs({
  current,
  onChange,
  trace,
  dagNodes,
  steps,
}: {
  current: EditorTab
  onChange: (tab: EditorTab) => void
  trace: TraceEntry[]
  dagNodes: DagNode[]
  steps: Step[]
}) {
  const tabs: Array<{ id: EditorTab; label: string; count?: number }> = [
    { id: "trace", label: "Trace", count: trace.length },
    { id: "dag", label: "DAG", count: dagNodes.length },
    { id: "timeline", label: "Timeline", count: steps.length },
    { id: "details", label: "Details" },
  ]

  return (
    <div
      className="flex items-center shrink-0"
      style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] transition-colors"
          style={{
            color: current === tab.id ? C.text : C.muted,
            background: current === tab.id ? C.base : "transparent",
            borderBottom: current === tab.id ? `1px solid ${C.accent}` : "1px solid transparent",
            borderRight: `1px solid ${C.border}`,
          }}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.count != null && tab.count > 0 && (
            <span className="text-[9px] px-1 rounded" style={{ background: C.elevated, color: C.dim }}>
              {tab.count}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}

// ── TracePanel ───────────────────────────────────────────────────

export function TracePanel({ trace }: { trace: TraceEntry[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [trace.length])

  if (trace.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs" style={{ color: C.dim }}>
        No trace data — start a run
      </div>
    )
  }

  return (
    <div ref={ref} className="h-full overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed">
      {trace.map((e, i) => (
        <TraceRow key={i} entry={e} />
      ))}
    </div>
  )
}

function TraceRow({ entry: e }: { entry: TraceEntry }) {
  const [expanded, setExpanded] = useState(false)

  if (e.kind === "goal") {
    return (
      <div className="py-0.5" style={{ color: C.accent }}>
        <span className="text-[10px] uppercase mr-2" style={{ color: C.dim }}>GOAL</span>
        {e.text}
      </div>
    )
  }
  if (e.kind === "iteration") {
    return (
      <div className="py-0.5 mt-1" style={{ color: C.cyan, borderTop: `1px solid ${C.border}` }}>
        ── Iteration {e.current}/{e.max} ──
      </div>
    )
  }
  if (e.kind === "thinking") {
    return (
      <div className="py-0.5 cursor-pointer hover:bg-white/[0.02] rounded" onClick={() => setExpanded(!expanded)}>
        <span className="text-[10px] mr-2" style={{ color: C.plum }}>THINK</span>
        <span style={{ color: C.muted }}>{expanded ? e.text : truncate(e.text, 120)}</span>
      </div>
    )
  }
  if (e.kind === "tool-call") {
    return (
      <div className="py-0.5 cursor-pointer hover:bg-white/[0.02] rounded" onClick={() => setExpanded(!expanded)}>
        <span className="text-[10px] mr-2" style={{ color: C.warning }}>CALL</span>
        <span style={{ color: C.text }}>{e.tool}</span>
        <span style={{ color: C.dim }}>({e.argsSummary || "..."})</span>
        {expanded && (
          <pre
            className="mt-1 ml-4 p-2 rounded text-[10px] overflow-x-auto"
            style={{ background: C.surface, color: C.muted, border: `1px solid ${C.border}` }}
          >
            {e.argsFormatted}
          </pre>
        )}
      </div>
    )
  }
  if (e.kind === "tool-result") {
    return (
      <div className="py-0.5 cursor-pointer hover:bg-white/[0.02] rounded" onClick={() => setExpanded(!expanded)}>
        <span className="text-[10px] mr-2" style={{ color: C.success }}>RET</span>
        <span style={{ color: C.textSecondary }}>{expanded ? e.text : truncate(e.text, 120)}</span>
      </div>
    )
  }
  if (e.kind === "tool-error") {
    return (
      <div className="py-0.5">
        <span className="text-[10px] mr-2" style={{ color: C.coral }}>ERR</span>
        <span style={{ color: C.coral }}>{truncate(e.text, 200)}</span>
      </div>
    )
  }
  if (e.kind === "answer") {
    return (
      <div className="py-1 mt-1" style={{ borderTop: `1px solid ${C.border}` }}>
        <span className="text-[10px] mr-2" style={{ color: C.success }}>ANSWER</span>
        <span style={{ color: C.text }}>{e.text}</span>
      </div>
    )
  }
  if (e.kind === "error") {
    return (
      <div className="py-0.5">
        <span className="text-[10px] mr-2" style={{ color: C.coral }}>ERROR</span>
        <span style={{ color: C.coral }}>{e.text}</span>
      </div>
    )
  }
  if (e.kind === "usage") {
    return (
      <div className="py-0.5" style={{ color: C.dim }}>
        <span className="text-[10px] mr-2">USAGE</span>
        {fmtK(e.totalTokens)} tokens · {e.llmCalls} calls
      </div>
    )
  }
  if (e.kind === "delegation-start") {
    return (
      <div className="py-0.5 mt-0.5" style={{ color: C.plum }}>
        <span className="text-[10px] mr-2">DELEG▶</span>
        {e.agentName ? `[${e.agentName}] ` : ""}
        {e.goal}
        <span style={{ color: C.dim }}> (depth {e.depth})</span>
      </div>
    )
  }
  if (e.kind === "delegation-end") {
    return (
      <div className="py-0.5" style={{ color: e.status === "done" ? C.success : C.coral }}>
        <span className="text-[10px] mr-2">DELEG◀</span>
        {e.status} {e.answer ? truncate(e.answer, 100) : e.error ? truncate(e.error, 100) : ""}
      </div>
    )
  }
  if (e.kind === "delegation-iteration") {
    return (
      <div className="py-0.5 pl-4" style={{ color: C.dim }}>
        ↳ D{e.depth} iter {e.iteration}/{e.maxIterations}
      </div>
    )
  }
  if (e.kind === "delegation-parallel-start") {
    return (
      <div className="py-0.5" style={{ color: C.plum }}>
        <span className="text-[10px] mr-2">PAR▶</span>
        {e.taskCount} tasks{" "}
        {e.goals.map((g, i) => (
          <Fragment key={i}>
            <br />
            <span className="pl-6" style={{ color: C.muted }}>• {truncate(g, 80)}</span>
          </Fragment>
        ))}
      </div>
    )
  }
  if (e.kind === "delegation-parallel-end") {
    return (
      <div className="py-0.5" style={{ color: C.plum }}>
        <span className="text-[10px] mr-2">PAR◀</span>
        {e.fulfilled}/{e.taskCount} fulfilled, {e.rejected} rejected
      </div>
    )
  }
  return null
}

// ── DagPanel ─────────────────────────────────────────────────────

export function DagPanel({
  nodes,
  expanded,
  onToggle,
}: {
  nodes: DagNode[]
  expanded: string | null
  onToggle: (id: string | null) => void
}) {
  if (nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs" style={{ color: C.dim }}>
        No activity yet
      </div>
    )
  }

  const toolCalls = nodes.filter((n) => n.type === "tool-call").length
  const doneCount = nodes.filter((n) => n.status === "done").length
  const failCount = nodes.filter((n) => n.status === "error").length
  const liveCount = nodes.filter((n) => n.status === "running").length

  return (
    <div className="h-full overflow-y-auto px-3 py-2 font-mono text-[11px]">
      <div className="flex items-center gap-3 mb-2 text-[10px]">
        <span style={{ color: C.success }}>LIVE {liveCount}</span>
        <span style={{ color: C.success }}>DONE {doneCount}</span>
        <span style={{ color: failCount > 0 ? C.coral : C.dim }}>FAIL {failCount}</span>
        <span style={{ color: C.dim }}>TOOLS {toolCalls}</span>
      </div>

      {nodes.map((node, i) => {
        const isExpanded = expanded === node.id
        const dotColor =
          node.status === "done"
            ? C.success
            : node.status === "error"
              ? C.coral
              : node.status === "partial"
                ? C.peach
                : C.accent
        const nextNode = nodes[i + 1]
        const isLast = !nextNode || nextNode.depth < node.depth
        const connector = node.depth === 0 ? (i > 0 ? "│" : " ") : isLast ? "└─" : "├─"

        return (
          <div key={node.id}>
            <div
              className="flex items-center gap-1.5 leading-relaxed cursor-pointer rounded px-1 -mx-1 hover:bg-white/[0.03] transition-colors"
              style={{ paddingLeft: node.depth * 16 }}
              onClick={() => onToggle(isExpanded ? null : node.id)}
            >
              <span className="inline-block w-4 text-right shrink-0" style={{ color: C.dim }}>
                {connector}
              </span>
              <span
                className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                style={{ background: dotColor }}
              />
              <span
                className="shrink-0 w-5 text-center text-[10px]"
                style={{
                  color: node.label.startsWith("D") ? C.cyan : node.depth === 0 ? C.accent : C.muted,
                }}
              >
                {node.label}
              </span>
              <span className="truncate flex-1" style={{ color: C.text }}>{node.detail}</span>
              <span className="shrink-0 text-[10px]" style={{ color: dotColor }}>
                {node.status === "running" ? "live" : node.status}
              </span>
            </div>
            {isExpanded && (
              <div
                className="mb-1 px-2 py-1 rounded text-[10px] overflow-auto"
                style={{
                  marginLeft: node.depth * 16 + 24,
                  background: C.surface,
                  border: `1px solid ${C.border}`,
                  maxHeight: 160,
                }}
              >
                <pre className="whitespace-pre-wrap m-0" style={{ color: C.muted }}>
                  {node.expanded}
                </pre>
                {node.resultText && (
                  <div
                    className="mt-1 pt-1"
                    style={{
                      borderTop: `1px solid ${C.border}`,
                      color: node.status === "error" ? C.coral : C.success,
                    }}
                  >
                    {node.resultText.slice(0, 400)}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── TimelinePanel ────────────────────────────────────────────────

export function TimelinePanel({
  steps,
  expanded,
  onToggle,
}: {
  steps: Step[]
  expanded: Set<string>
  onToggle: (id: string) => void
}) {
  if (steps.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs" style={{ color: C.dim }}>
        No steps recorded
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto px-3 py-2 text-xs">
      {steps.map((step, i) => {
        const isOpen = expanded.has(step.id)
        const dotColor = statusDot(step.status)
        const duration = dur(step.startedAt, step.completedAt)

        return (
          <div key={step.id} className="relative pl-5 pb-2">
            {i < steps.length - 1 && (
              <div className="absolute left-2 top-3.5 bottom-0 w-px" style={{ background: C.borderSolid }} />
            )}
            <div
              className="absolute left-[5px] top-1.5 w-2.5 h-2.5 rounded-full border-2"
              style={{
                borderColor: dotColor,
                background: step.status === "running" ? dotColor : C.base,
              }}
            />

            <div
              className="cursor-pointer hover:bg-white/[0.02] rounded px-2 py-1 transition-colors"
              onClick={() => onToggle(step.id)}
            >
              <div className="flex items-center gap-2">
                <span style={{ color: C.text }}>{step.name}</span>
                {step.action !== step.name && <span style={{ color: C.dim }}>({step.action})</span>}
                <span className="ml-auto text-[10px]" style={{ color: C.dim }}>{duration}</span>
                <span className="text-[10px]" style={{ color: dotColor }}>{step.status}</span>
              </div>
              {step.error && (
                <div className="mt-0.5" style={{ color: C.error }}>{truncate(step.error, 100)}</div>
              )}

              {isOpen && (
                <div className="mt-1.5 space-y-1">
                  {Object.keys(step.input).length > 0 && (
                    <div>
                      <span className="text-[10px] uppercase" style={{ color: C.dim }}>Input</span>
                      <pre
                        className="mt-0.5 p-2 rounded text-[10px] overflow-x-auto"
                        style={{ background: C.surface, color: C.muted, border: `1px solid ${C.border}` }}
                      >
                        {JSON.stringify(step.input, null, 2)}
                      </pre>
                    </div>
                  )}
                  {Object.keys(step.output).length > 0 && (
                    <div>
                      <span className="text-[10px] uppercase" style={{ color: C.dim }}>Output</span>
                      <pre
                        className="mt-0.5 p-2 rounded text-[10px] overflow-x-auto"
                        style={{ background: C.surface, color: C.muted, border: `1px solid ${C.border}` }}
                      >
                        {JSON.stringify(step.output, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── DetailsPanel ─────────────────────────────────────────────────

export function DetailsPanel({
  run,
  toolStats,
  liveUsage,
  usage,
}: {
  run: Run | undefined
  toolStats: Map<string, { calls: number; errors: number; totalMs: number }>
  liveUsage: { promptTokens: number; completionTokens: number; totalTokens: number; llmCalls: number }
  usage: UsageData | null
}) {
  return (
    <div className="h-full overflow-y-auto px-4 py-3 text-xs space-y-4">
      <section>
        <h3 className="text-[11px] uppercase tracking-wide mb-2" style={{ color: C.cyan }}>Run Usage</h3>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1">
          <KV label="Prompt Tokens" value={fmtK(liveUsage.promptTokens)} />
          <KV label="Completion Tokens" value={fmtK(liveUsage.completionTokens)} />
          <KV label="Total Tokens" value={fmtK(liveUsage.totalTokens)} />
          <KV label="LLM Calls" value={String(liveUsage.llmCalls)} />
        </div>
      </section>

      {usage && (
        <section>
          <h3 className="text-[11px] uppercase tracking-wide mb-2" style={{ color: C.cyan }}>
            Overall Usage
          </h3>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1">
            <KV label="Total Tokens" value={fmtK(usage.totals.totalTokens)} />
            <KV label="Total Runs" value={String(usage.totals.runCount)} />
            <KV label="LLM Calls" value={String(usage.totals.llmCalls)} />
            <KV label="Prompt Tokens" value={fmtK(usage.totals.promptTokens)} />
          </div>
        </section>
      )}

      {toolStats.size > 0 && (
        <section>
          <h3 className="text-[11px] uppercase tracking-wide mb-2" style={{ color: C.cyan }}>
            Tool Performance
          </h3>
          <div className="space-y-1.5">
            {Array.from(toolStats.entries()).map(([name, s]) => {
              const failRate = s.calls > 0 ? s.errors / s.calls : 0
              const avgMs = s.calls > 0 ? Math.round(s.totalMs / s.calls) : 0
              return (
                <div key={name} className="flex items-center gap-2">
                  <span className="w-24 truncate" style={{ color: C.accent }}>{name}</span>
                  <div
                    className="flex-1 h-1.5 rounded-full overflow-hidden"
                    style={{ background: C.elevated }}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min(100, s.calls * 10)}%`,
                        background: failRate > 0.3 ? C.coral : C.success,
                      }}
                    />
                  </div>
                  <span className="shrink-0 w-16 text-right" style={{ color: C.muted }}>
                    {s.calls}× {avgMs > 0 ? `${avgMs}ms` : ""}
                  </span>
                  {s.errors > 0 && (
                    <span className="shrink-0 text-[10px]" style={{ color: C.coral }}>{s.errors} err</span>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {run && (
        <section>
          <h3 className="text-[11px] uppercase tracking-wide mb-2" style={{ color: C.cyan }}>
            Run Metadata
          </h3>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1">
            <KV label="Run ID" value={run.id.slice(0, 12)} />
            <KV label="Status" value={run.status} />
            <KV label="Agent" value={run.agentId ?? "default"} />
            <KV label="Created" value={ts(run.createdAt)} />
            {run.completedAt && <KV label="Completed" value={ts(run.completedAt)} />}
            {run.parentRunId && <KV label="Parent Run" value={run.parentRunId.slice(0, 8)} />}
          </div>
        </section>
      )}
    </div>
  )
}
