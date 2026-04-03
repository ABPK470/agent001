/**
 * IOE editor-area panels — Trace, DAG, Timeline, Details, Map, EditorTabs.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { AgentDefinition, Run, Step, TraceEntry } from "../../types"
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
  // Count only user-visible trace entries (exclude debug/internal ones)
  const visibleTraceCount = useMemo(() =>
    trace.filter((e) =>
      e.kind === "goal" || e.kind === "iteration" || e.kind === "thinking" ||
      e.kind === "tool-call" || e.kind === "tool-result" || e.kind === "tool-error" ||
      e.kind === "answer" || e.kind === "error" || e.kind === "usage" ||
      e.kind === "delegation-start" || e.kind === "delegation-end" || e.kind === "delegation-iteration" ||
      e.kind === "delegation-parallel-start" || e.kind === "delegation-parallel-end"
    ).length,
    [trace],
  )

  // Count tool-call DAG nodes only (not thinking, not iterations)
  const dagToolCount = useMemo(() =>
    dagNodes.filter((n) => n.type === "tool-call").length,
    [dagNodes],
  )

  const tabs: Array<{ id: EditorTab; label: string; count?: number }> = [
    { id: "trace", label: "Trace", count: visibleTraceCount },
    { id: "dag", label: "DAG", count: dagToolCount },
    { id: "timeline", label: "Timeline", count: steps.length },
    { id: "details", label: "Details" },
    { id: "map", label: "Map" },
  ]

  return (
    <>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[13px] transition-colors cursor-pointer"
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
            <span className="text-[12px] px-1 rounded" style={{ background: C.elevated, color: C.dim }}>
              {tab.count}
            </span>
          )}
        </button>
      ))}
    </>
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
      <div className="flex items-center justify-center h-full text-[13px]" style={{ color: C.dim }}>
        No trace data — start a run
      </div>
    )
  }

  return (
    <div ref={ref} className="h-full overflow-y-auto px-3 py-2 font-mono text-[13px] leading-relaxed">
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
      <div className="pt-2 pb-1">
        <span className="text-[13px] font-semibold mr-2" style={{ color: C.accent }}>GOAL</span>
        <span className="text-[13px]" style={{ color: C.text }}>{e.text}</span>
      </div>
    )
  }
  if (e.kind === "iteration") {
    return (
      <div
        className="text-[13px] font-mono pt-3 pb-0.5 mt-2 flex items-center gap-2"
        style={{ color: C.muted, borderTop: `1px solid ${C.border}` }}
      >
        <span style={{ opacity: 0.6 }}>──</span>
        <span>iteration {e.current}/{e.max}</span>
        <span style={{ opacity: 0.6 }}>──</span>
      </div>
    )
  }
  if (e.kind === "thinking") {
    return (
      <div className="py-0.5 pl-3" style={{ borderLeft: `2px solid ${C.accent}4d` }}>
        <span className="text-[13px] font-medium mr-2" style={{ color: C.accent }}>THK</span>
        <span className="text-[13px] whitespace-pre-wrap" style={{ color: C.textSecondary }}>{e.text}</span>
      </div>
    )
  }
  if (e.kind === "tool-call") {
    return (
      <div className="py-1">
        <div
          className="flex items-center gap-2 cursor-pointer"
          onClick={() => setExpanded(!expanded)}
        >
          <span className="text-[13px] font-medium font-mono" style={{ color: C.warning }}>CALL</span>
          <span className="text-[13px] font-medium font-mono" style={{ color: C.text }}>{e.tool}</span>
          {!expanded && e.argsSummary && (
            <span className="text-[13px] font-mono truncate" style={{ color: C.muted }}>{e.argsSummary}</span>
          )}
        </div>
        {expanded && (
          <pre
            className="text-[13px] font-mono rounded-lg p-2 mt-1 max-h-40 overflow-auto whitespace-pre-wrap"
            style={{ background: C.base, color: C.textSecondary, border: `1px solid ${C.border}` }}
          >
            {e.argsFormatted}
          </pre>
        )}
      </div>
    )
  }
  if (e.kind === "tool-result") {
    return (
      <div className="py-0.5 pl-3">
        <div
          className="flex items-center gap-2 cursor-pointer"
          onClick={() => setExpanded(!expanded)}
        >
          <span className="text-[13px] font-medium font-mono" style={{ color: C.success }}>RSLT</span>
          {!expanded && (
            <span className="text-[13px] font-mono truncate" style={{ color: C.muted }}>
              {e.text.length > 120 ? e.text.slice(0, 120) + "..." : e.text}
            </span>
          )}
        </div>
        {expanded && (
          <pre
            className="text-[13px] font-mono rounded-lg p-2 mt-1 max-h-40 overflow-auto whitespace-pre-wrap"
            style={{ background: C.base, color: C.textSecondary, border: `1px solid ${C.border}` }}
          >
            {e.text}
          </pre>
        )}
      </div>
    )
  }
  if (e.kind === "tool-error") {
    return (
      <div className="py-0.5 pl-3">
        <span className="text-[13px] font-medium font-mono mr-2" style={{ color: C.coral }}>ERR</span>
        <span className="text-[13px]" style={{ color: C.coral, opacity: 0.8 }}>{e.text}</span>
      </div>
    )
  }
  if (e.kind === "answer") {
    return (
      <div className="pt-2 pb-1 mt-1" style={{ borderTop: `1px solid ${C.border}` }}>
        <div className="text-[13px] font-semibold mb-1" style={{ color: C.success }}>COMPLETED</div>
        <div className="text-[13px] whitespace-pre-wrap leading-relaxed" style={{ color: C.textSecondary }}>{e.text}</div>
      </div>
    )
  }
  if (e.kind === "error") {
    return (
      <div className="pt-2 pb-1 mt-1" style={{ borderTop: `1px solid ${C.border}` }}>
        <span className="text-[13px] font-semibold mr-2" style={{ color: C.coral }}>FAILED</span>
        <span className="text-[13px]" style={{ color: C.coral, opacity: 0.8 }}>{e.text}</span>
      </div>
    )
  }
  if (e.kind === "usage") {
    return (
      <div className="flex items-center gap-3 py-0.5 text-[12px] font-mono" style={{ color: C.dim }}>
        <span>+{fmtK(e.iterationTokens)} tk</span>
        <span style={{ opacity: 0.3 }}>│</span>
        <span>total {fmtK(e.totalTokens)}</span>
        <span style={{ opacity: 0.3 }}>│</span>
        <span>{e.llmCalls} calls</span>
      </div>
    )
  }
  if (e.kind === "delegation-start") {
    return (
      <div className="py-1 pl-3 mt-1" style={{ borderLeft: "2px solid #6CB4EE66" }}>
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium font-mono" style={{ color: "#6CB4EE" }}>DLGT</span>
          <span className="text-[13px]" style={{ color: "#6CB4EE", opacity: 0.7 }}>▶</span>
          {e.agentName && (
            <span className="text-[13px] font-medium" style={{ color: C.textSecondary }}>[{e.agentName}]</span>
          )}
          <span className="text-[12px]" style={{ color: C.muted }}>depth {e.depth}</span>
        </div>
        <div className="text-[13px] mt-0.5 ml-5" style={{ color: C.textSecondary }}>
          {e.goal.length > 200 ? e.goal.slice(0, 200) + "..." : e.goal}
        </div>
        <div className="text-[11px] font-mono mt-0.5 ml-5" style={{ color: C.dim, opacity: 0.5 }}>
          tools: {e.tools.slice(0, 6).join(", ")}{e.tools.length > 6 ? ` +${e.tools.length - 6}` : ""}
        </div>
      </div>
    )
  }
  if (e.kind === "delegation-end") {
    return (
      <div className="py-1 pl-3 mb-1" style={{ borderLeft: "2px solid #6CB4EE66" }}>
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium font-mono" style={{ color: "#6CB4EE" }}>DLGT</span>
          <span className="text-[13px]" style={{ color: e.status === "done" ? C.success : C.coral }}>◀ {e.status}</span>
          <span className="text-[12px]" style={{ color: C.muted }}>depth {e.depth}</span>
        </div>
        {e.answer && (
          <div
            className="text-[13px] mt-0.5 ml-5 cursor-pointer"
            style={{ color: C.textSecondary }}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? e.answer : (e.answer.length > 150 ? e.answer.slice(0, 150) + "..." : e.answer)}
          </div>
        )}
        {e.error && (
          <div className="text-[13px] mt-0.5 ml-5" style={{ color: C.coral, opacity: 0.8 }}>{e.error}</div>
        )}
      </div>
    )
  }
  if (e.kind === "delegation-iteration") {
    return (
      <div className="text-[12px] font-mono pl-6 py-0.5" style={{ color: C.dim, opacity: 0.5 }}>
        ↳ child iteration {e.iteration}/{e.maxIterations}
      </div>
    )
  }
  if (e.kind === "delegation-parallel-start") {
    return (
      <div className="py-1 pl-3 mt-1" style={{ borderLeft: "2px solid #6CB4EE66" }}>
        <span className="text-[13px] font-medium font-mono mr-2" style={{ color: "#6CB4EE" }}>PAR▶</span>
        <span className="text-[13px]" style={{ color: C.muted }}>{e.taskCount} tasks</span>
        {e.goals.map((g, i) => (
          <Fragment key={i}>
            <br />
            <span className="pl-6 text-[13px]" style={{ color: C.muted }}>• {truncate(g, 80)}</span>
          </Fragment>
        ))}
      </div>
    )
  }
  if (e.kind === "delegation-parallel-end") {
    return (
      <div className="py-1 pl-3 mb-1" style={{ borderLeft: "2px solid #6CB4EE66" }}>
        <span className="text-[13px] font-medium font-mono mr-2" style={{ color: "#6CB4EE" }}>PAR◀</span>
        <span className="text-[13px]" style={{ color: C.muted }}>{e.fulfilled}/{e.taskCount} fulfilled, {e.rejected} rejected</span>
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
      <div className="flex items-center justify-center h-full text-[13px]" style={{ color: C.dim }}>
        No activity yet
      </div>
    )
  }

  const toolCalls = nodes.filter((n) => n.type === "tool-call").length
  const doneCount = nodes.filter((n) => n.status === "done").length
  const failCount = nodes.filter((n) => n.status === "error").length
  const liveCount = nodes.filter((n) => n.status === "running").length

  return (
    <div className="h-full overflow-y-auto px-3 py-2 font-mono text-[13px]">
      <div className="flex items-center gap-3 mb-2 text-[13px]">
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
                className="shrink-0 w-5 text-center text-[13px]"
                style={{
                  color: node.label.startsWith("D") ? C.cyan : node.depth === 0 ? C.accent : C.muted,
                }}
              >
                {node.label}
              </span>
              <span className="truncate flex-1" style={{ color: C.text }}>{node.detail}</span>
              <span className="shrink-0 text-[13px]" style={{ color: dotColor }}>
                {node.status === "running" ? "live" : node.status}
              </span>
            </div>
            {isExpanded && (
              <div
                className="mb-1 px-2 py-1 rounded text-[13px] overflow-auto"
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
      <div className="flex items-center justify-center h-full text-[13px]" style={{ color: C.dim }}>
        No steps recorded
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto px-3 py-2 text-[13px]">
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
                <span className="ml-auto text-[13px]" style={{ color: C.dim }}>{duration}</span>
                <span className="text-[13px]" style={{ color: dotColor }}>{step.status}</span>
              </div>
              {step.error && (
                <div className="mt-0.5" style={{ color: C.error }}>{truncate(step.error, 100)}</div>
              )}

              {isOpen && (
                <div className="mt-1.5 space-y-1">
                  {step.input && Object.keys(step.input).length > 0 && (
                    <div>
                      <span className="text-[13px] uppercase" style={{ color: C.dim }}>Input</span>
                      <pre
                        className="mt-0.5 p-2 rounded text-[13px] overflow-x-auto"
                        style={{ background: C.surface, color: C.muted, border: `1px solid ${C.border}` }}
                      >
                        {JSON.stringify(step.input, null, 2)}
                      </pre>
                    </div>
                  )}
                  {step.output && Object.keys(step.output).length > 0 && (
                    <div>
                      <span className="text-[13px] uppercase" style={{ color: C.dim }}>Output</span>
                      <pre
                        className="mt-0.5 p-2 rounded text-[13px] overflow-x-auto"
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
  // For completed/failed runs, use the run's own token data; liveUsage is only valid while running
  const runUsage = run && run.status !== "running" && run.status !== "pending"
    ? { promptTokens: run.promptTokens, completionTokens: run.completionTokens, totalTokens: run.totalTokens, llmCalls: run.llmCalls }
    : liveUsage

  return (
    <div className="h-full overflow-y-auto px-4 py-3 text-[13px] space-y-4">
      <section>
        <h3 className="text-[13px] uppercase tracking-wide mb-2" style={{ color: C.cyan }}>Run Usage</h3>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1">
          <KV label="Prompt Tokens" value={fmtK(runUsage.promptTokens)} />
          <KV label="Completion Tokens" value={fmtK(runUsage.completionTokens)} />
          <KV label="Total Tokens" value={fmtK(runUsage.totalTokens)} />
          <KV label="LLM Calls" value={String(runUsage.llmCalls)} />
        </div>
      </section>

      {usage && (
        <section>
          <h3 className="text-[13px] uppercase tracking-wide mb-2" style={{ color: C.cyan }}>
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
          <h3 className="text-[13px] uppercase tracking-wide mb-2" style={{ color: C.cyan }}>
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
                    <span className="shrink-0 text-[13px]" style={{ color: C.coral }}>{s.errors} err</span>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {run && (
        <section>
          <h3 className="text-[13px] uppercase tracking-wide mb-2" style={{ color: C.cyan }}>
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

// ── MapPanel — force-directed agent/tool graph ───────────────────

import type { ForceGraphMethods, LinkObject, NodeObject } from "react-force-graph-2d"
import ForceGraph2D from "react-force-graph-2d"

const AGENT_COLORS = [C.accent, "#D17877", "#F49D6C", "#EA6248", C.success, C.plum, "#6CB4EE", "#B8A9C9"]

const MAP_TOOL_LABELS: Record<string, string> = {
  read_file: "Read",
  write_file: "Write",
  list_directory: "List",
  run_command: "Shell",
  fetch_url: "Fetch",
  delegate: "Delegate",
  browse_web: "Browse",
  browser_check: "BrChk",
  ask_user: "Ask",
}
function mapToolLabel(id: string): string {
  return MAP_TOOL_LABELS[id] ?? id.slice(0, 8)
}

interface MapNode {
  id: string
  type: "agent" | "tool" | "delegate"
  label: string
  color: string
  agentId?: string
  toolId?: string
  delegateDepth?: number
  delegateStatus?: "active" | "done" | "error"
  val?: number
  x?: number
  y?: number
}

interface MapLink {
  source: string
  target: string
  agentId: string
  color: string
}

export function MapPanel({
  trace,
  run,
  agents,
}: {
  trace: TraceEntry[]
  run: Run | undefined
  agents: AgentDefinition[]
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<ForceGraphMethods<NodeObject<MapNode>, LinkObject<MapNode, MapLink>>>(undefined)
  const [size, setSize] = useState({ w: 600, h: 400 })
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const prevTraceLen = useRef(0)
  const [zoomLevel, setZoomLevel] = useState(100)
  const zoomBaseRef = useRef(1)
  const animPhaseRef = useRef(0)
  const rafRef = useRef<number>(0)

  const isRunning = run?.status === "running"
  const activeAgentId = run?.agentId ?? null

  // Resize observer
  useEffect(() => {
    if (!containerRef.current) return
    const obs = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      if (width > 0 && height > 0) setSize({ w: width, h: height })
    })
    obs.observe(containerRef.current)
    return () => obs.disconnect()
  }, [])

  // Tool stats from trace
  const toolStats = useMemo(() => {
    const stats = new Map<string, { calls: number; errors: number; lastStatus: "idle" | "running" | "done" | "error" }>()
    let currentTool: string | null = null
    for (const entry of trace) {
      if (entry.kind === "tool-call") {
        currentTool = entry.tool
        const s = stats.get(entry.tool) ?? { calls: 0, errors: 0, lastStatus: "idle" as const }
        s.calls++
        s.lastStatus = "running"
        stats.set(entry.tool, s)
      } else if (entry.kind === "tool-result" && currentTool) {
        const s = stats.get(currentTool)
        if (s) s.lastStatus = "done"
        currentTool = null
      } else if (entry.kind === "tool-error" && currentTool) {
        const s = stats.get(currentTool)
        if (s) { s.errors++; s.lastStatus = "error" }
        currentTool = null
      }
    }
    return stats
  }, [trace])

  // Stabilised involved tool IDs
  const prevInvolvedRef = useRef<Set<string>>(new Set())
  const involvedToolIds = useMemo(() => {
    const ids = new Set<string>()
    for (const entry of trace) {
      if (entry.kind === "tool-call") ids.add(entry.tool)
    }
    const prev = prevInvolvedRef.current
    if (ids.size === prev.size && [...ids].every(id => prev.has(id))) return prev
    prevInvolvedRef.current = ids
    return ids
  }, [trace])

  // Stabilised delegations
  const prevDelegRef = useRef<Array<{ key: string; depth: number; goal: string; tools: string[]; status: "active" | "done" | "error" }>>([])
  const traceDelegations = useMemo(() => {
    const all: Array<{ key: string; depth: number; goal: string; tools: string[]; status: "active" | "done" | "error" }> = []
    const active: number[] = []
    for (const e of trace) {
      if (e.kind === "delegation-start") {
        const idx = all.length
        all.push({ key: `d${idx}`, depth: e.depth, goal: e.goal, tools: e.tools, status: "active" })
        active.push(idx)
      } else if (e.kind === "delegation-end") {
        for (let j = active.length - 1; j >= 0; j--) {
          if (all[active[j]].depth === e.depth) {
            all[active[j]].status = e.status === "error" ? "error" : "done"
            active.splice(j, 1)
            break
          }
        }
      }
    }
    const prev = prevDelegRef.current
    if (prev.length === all.length && prev.every((d, i) => d.key === all[i].key && d.status === all[i].status)) return prev
    prevDelegRef.current = all
    return all
  }, [trace])

  const hasRunContext = activeAgentId != null && trace.length > 0

  // Build graph — stabilised topology
  const prevGraphRef = useRef<{ nodes: MapNode[]; links: MapLink[] }>({ nodes: [], links: [] })
  const graphData = useMemo(() => {
    const nodes: MapNode[] = []
    const links: MapLink[] = []
    const toolNodeIds = new Set<string>()

    agents.forEach((agent, idx) => {
      const agentColor = AGENT_COLORS[idx % AGENT_COLORS.length]
      const agentNodeId = `agent:${agent.id}`

      nodes.push({
        id: agentNodeId, type: "agent", label: agent.name, color: agentColor,
        agentId: agent.id, val: 5, x: -60, y: (idx - (agents.length - 1) / 2) * 50,
      })

      for (const toolId of agent.tools) {
        const toolNodeId = `tool:${toolId}`
        if (!toolNodeIds.has(toolNodeId)) {
          const toolIdx = toolNodeIds.size
          toolNodeIds.add(toolNodeId)
          nodes.push({
            id: toolNodeId, type: "tool", label: mapToolLabel(toolId), color: C.dim,
            toolId, val: 3, x: 60, y: (toolIdx - 2.5) * 40,
          })
        }
        links.push({ source: agentNodeId, target: `tool:${toolId}`, agentId: agent.id, color: agentColor })
      }

      // Runtime-injected tools from trace
      for (const toolId of involvedToolIds) {
        const toolNodeId = `tool:${toolId}`
        if (!toolNodeIds.has(toolNodeId)) {
          const toolIdx = toolNodeIds.size
          toolNodeIds.add(toolNodeId)
          nodes.push({
            id: toolNodeId, type: "tool", label: mapToolLabel(toolId), color: C.dim,
            toolId, val: 3, x: 60, y: (toolIdx - 2.5) * 40,
          })
        }
        if (!links.some(l => l.source === agentNodeId && (typeof l.target === "string" ? l.target : (l.target as MapNode).id) === toolNodeId)) {
          links.push({ source: agentNodeId, target: toolNodeId, agentId: agent.id, color: agentColor })
        }
      }
    })

    // Delegation nodes
    for (const deleg of traceDelegations) {
      const delegId = `delegate:${deleg.key}`
      const baseColor = AGENT_COLORS[(agents.length + deleg.depth) % AGENT_COLORS.length]
      const color = deleg.status === "error" ? C.coral : baseColor
      nodes.push({
        id: delegId, type: "delegate", label: `D${deleg.depth}`, color,
        delegateDepth: deleg.depth, delegateStatus: deleg.status,
        val: 4, x: -30, y: (agents.length + deleg.depth - 1) * 50,
      })
      if (activeAgentId) {
        links.push({ source: `agent:${activeAgentId}`, target: delegId, agentId: activeAgentId, color })
      }
      for (const toolName of deleg.tools) {
        if (toolName === "delegate") continue
        const toolNodeId = `tool:${toolName}`
        if (toolNodeIds.has(toolNodeId)) {
          links.push({ source: delegId, target: toolNodeId, agentId: activeAgentId ?? "", color: color + "80" })
        }
      }
    }

    // Structural comparison
    const prev = prevGraphRef.current
    const nk = nodes.map(n => n.id).join("\0")
    const lk = links.map(l => `${l.source}\0${l.target}`).join("\0")
    const pnk = prev.nodes.map(n => n.id).join("\0")
    const plk = prev.links.map(l => {
      const s = typeof l.source === "string" ? l.source : (l.source as MapNode).id
      const t = typeof l.target === "string" ? l.target : (l.target as MapNode).id
      return `${s}\0${t}`
    }).join("\0")
    if (nk === pnk && lk === plk) return prev
    prevGraphRef.current = { nodes, links }
    return { nodes, links }
  }, [agents, traceDelegations, activeAgentId, involvedToolIds])

  // Set of currently-running tool IDs (for highlighting)
  const activeToolSet = useMemo(() => {
    const set = new Set<string>()
    for (const [id, s] of toolStats) { if (s.lastStatus === "running") set.add(id) }
    return set
  }, [toolStats])

  // Animate while tools are running — keeps canvas repainting
  useEffect(() => {
    if (activeToolSet.size === 0) return
    let running = true
    const tick = () => {
      if (!running) return
      animPhaseRef.current = Date.now()
      // Briefly reheat to force a repaint frame; very low alpha so nodes barely move
      const fg = graphRef.current
      if (fg) { fg.d3ReheatSimulation(); fg.d3Force("charge")?.strength(-120) }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { running = false; cancelAnimationFrame(rafRef.current) }
  }, [activeToolSet.size])

  // Track new tool calls for edge flash
  useEffect(() => {
    if (trace.length <= prevTraceLen.current) { prevTraceLen.current = trace.length; return }
    prevTraceLen.current = trace.length
  }, [trace])

  // Configure d3 forces
  useEffect(() => {
    const fg = graphRef.current
    if (!fg) return
    fg.d3Force("link")?.distance(55).strength(0.2)
    fg.d3Force("charge")?.strength(-120).distanceMax(200)
    let forceNodes: NodeObject<MapNode>[] = []
    const xBias = (alpha: number) => {
      for (const node of forceNodes) {
        if (node.fx != null) continue
        const target = node.type === "agent" ? -60 : node.type === "delegate" ? -30 : 60
        node.vx = (node.vx ?? 0) + (target - (node.x ?? 0)) * 0.02 * alpha
      }
    }
    xBias.initialize = (nodes: NodeObject<MapNode>[]) => { forceNodes = nodes }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fg.d3Force("xBias", xBias as any)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Fit to view
  useEffect(() => {
    const fg = graphRef.current
    if (!fg || agents.length === 0) return
    const timer = setTimeout(() => {
      fg.zoomToFit(400, 60)
      setTimeout(() => {
        const z = fg.zoom()
        zoomBaseRef.current = z
        setZoomLevel(100)
      }, 450)
    }, 300)
    return () => clearTimeout(timer)
  }, [agents.length])

  // Track zoom
  const handleZoom = useCallback((transform: { k: number }) => {
    queueMicrotask(() => {
      const base = zoomBaseRef.current
      setZoomLevel(base > 0 ? Math.round((transform.k / base) * 100) : 100)
    })
  }, [])

  // Paint node
  const paintNode = useCallback((node: NodeObject<MapNode>, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const x = node.x ?? 0
    const y = node.y ?? 0
    const r = node.type === "agent" ? 10 : node.type === "delegate" ? 8 : 7

    if (node.type === "delegate") {
      const isDone = node.delegateStatus === "done" || node.delegateStatus === "error"
      const opacity = isDone ? "66" : "cc"
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(Math.PI / 4)
      ctx.fillStyle = "#342F57" + opacity
      ctx.fillRect(-r * 0.7, -r * 0.7, r * 1.4, r * 1.4)
      ctx.strokeStyle = node.color + (isDone ? "55" : "bb")
      ctx.lineWidth = 1.2
      ctx.strokeRect(-r * 0.7, -r * 0.7, r * 1.4, r * 1.4)
      if (isDone) {
        ctx.restore()
        ctx.font = `${Math.max(4, 10 / globalScale)}px sans-serif`
        ctx.fillStyle = (node.delegateStatus === "error" ? C.coral : C.success) + "aa"
        ctx.textAlign = "center"; ctx.textBaseline = "middle"
        ctx.fillText(node.delegateStatus === "error" ? "✗" : "✓", x, y)
      } else { ctx.restore() }
      ctx.font = `${Math.max(4, 12 / globalScale)}px sans-serif`
      ctx.fillStyle = node.color; ctx.textAlign = "center"; ctx.textBaseline = "top"
      ctx.fillText(node.label, x, y + r + 3)
      return
    }

    if (node.type === "agent") {
      const isActive = node.agentId === activeAgentId
      const dimmed = hasRunContext && !isActive
      if (isActive && hasRunContext) {
        ctx.fillStyle = node.color + (isRunning ? "18" : "0c")
        ctx.beginPath(); ctx.arc(x, y, r * 1.5, 0, Math.PI * 2); ctx.fill()
      }
      ctx.fillStyle = dimmed ? C.base + "aa" : "#342F57cc"
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = dimmed ? C.dim + "30" : node.color + (isActive && hasRunContext ? "aa" : "60")
      ctx.lineWidth = isActive && hasRunContext ? 1.2 : dimmed ? 0.5 : 0.8; ctx.stroke()
      ctx.font = `${Math.max(4, 13 / globalScale)}px sans-serif`
      ctx.fillStyle = dimmed ? C.muted + "40" : isActive && hasRunContext ? C.text : C.text + "bb"
      ctx.textAlign = "center"; ctx.textBaseline = "top"
      ctx.fillText(node.label, x, y + r + 3)
    } else {
      // Tool node
      const stats = toolStats.get(node.toolId ?? "")
      const active = stats?.lastStatus === "running"
      const wasUsed = involvedToolIds.has(node.toolId ?? "")
      const dimmed = hasRunContext && !wasUsed
      const toolColor = active ? C.accent : stats?.lastStatus === "error" ? C.coral : stats?.lastStatus === "done" ? C.success : C.dim

      // Progress spinner ring for active tools
      if (active) {
        const t = animPhaseRef.current * 0.003
        const arcLen = Math.PI * 0.8
        ctx.beginPath()
        ctx.arc(x, y, r + 3, t, t + arcLen)
        ctx.strokeStyle = C.accent + "88"
        ctx.lineWidth = 1.8
        ctx.lineCap = "round"
        ctx.stroke()
        // Glow behind the node
        ctx.fillStyle = C.accent + "12"
        ctx.beginPath(); ctx.arc(x, y, r + 5, 0, Math.PI * 2); ctx.fill()
      }

      ctx.fillStyle = dimmed ? C.base + "88" : C.elevated
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = dimmed ? C.dim + "20" : toolColor + (active ? "cc" : wasUsed ? "88" : "60")
      ctx.lineWidth = active ? 1.8 : dimmed ? 0.5 : 0.8; ctx.stroke()
      if (stats && stats.calls > 0) {
        ctx.font = `${Math.max(4, 12 / globalScale)}px sans-serif`
        ctx.fillStyle = dimmed ? toolColor + "30" : toolColor
        ctx.textAlign = "center"; ctx.textBaseline = "middle"
        ctx.fillText(stats.calls > 99 ? "99+" : String(stats.calls), x, y + 0.5)
      } else {
        ctx.fillStyle = dimmed ? toolColor + "10" : toolColor + "40"
        ctx.beginPath(); ctx.arc(x, y, r * 0.2, 0, Math.PI * 2); ctx.fill()
      }
      ctx.font = `${Math.max(4, 12 / globalScale)}px sans-serif`
      ctx.fillStyle = dimmed ? C.muted + "30" : stats && stats.calls > 0 ? C.text : C.muted
      ctx.textAlign = "center"; ctx.textBaseline = "top"
      ctx.fillText(node.label, x, y + r + 2)
    }
  }, [activeAgentId, hasRunContext, isRunning, toolStats, involvedToolIds])

  // Node hit area
  const paintNodeArea = useCallback((node: NodeObject<MapNode>, color: string, ctx: CanvasRenderingContext2D) => {
    const r = node.type === "agent" ? 12 : node.type === "delegate" ? 10 : 9
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, Math.PI * 2); ctx.fill()
  }, [])

  const handleNodeClick = useCallback((node: NodeObject<MapNode>) => {
    setSelectedNode((prev) => prev === node.id ? null : (node.id as string))
  }, [])

  const handleNodeDragEnd = useCallback((node: NodeObject<MapNode>) => {
    node.fx = node.x; node.fy = node.y
  }, [])

  // Custom link renderer
  const paintLink = useCallback((link: LinkObject<MapNode, MapLink>, ctx: CanvasRenderingContext2D) => {
    const vLink = link as unknown as MapLink
    const src = link.source as NodeObject<MapNode>
    const tgt = link.target as NodeObject<MapNode>
    if (!src || !tgt || src.x == null || tgt.x == null) return
    const isActiveLink = vLink.agentId === activeAgentId
    const tgtToolId = tgt.id?.toString().replace("tool:", "") ?? ""
    const toolUsed = involvedToolIds.has(tgtToolId)
    const toolRunning = activeToolSet.has(tgtToolId)
    const highlight = hasRunContext && isActiveLink && toolUsed
    const isLive = hasRunContext && isActiveLink && toolRunning
    const dimmed = hasRunContext && !isActiveLink
    const alpha = isLive ? "88" : highlight ? "44" : dimmed ? "08" : "1a"
    const mx = (src.x + tgt.x) / 2, my = (src.y! + tgt.y!) / 2
    const dx = tgt.x - src.x, dy = tgt.y! - src.y!
    const len = Math.sqrt(dx * dx + dy * dy) || 1
    const offset = len * 0.08
    const cx = mx + (-dy / len) * offset, cy = my + (dx / len) * offset

    if (isLive) {
      // Animated dashed line for currently-running tool edge
      ctx.save()
      ctx.setLineDash([4, 4])
      ctx.lineDashOffset = -(animPhaseRef.current * 0.04) % 8
      ctx.beginPath(); ctx.moveTo(src.x, src.y!); ctx.quadraticCurveTo(cx, cy, tgt.x, tgt.y!)
      ctx.strokeStyle = vLink.color + alpha; ctx.lineWidth = 2; ctx.stroke()
      ctx.restore()
    } else {
      ctx.beginPath(); ctx.moveTo(src.x, src.y!); ctx.quadraticCurveTo(cx, cy, tgt.x, tgt.y!)
      ctx.strokeStyle = vLink.color + alpha; ctx.lineWidth = highlight ? 1.2 : 0.5; ctx.stroke()
    }
  }, [activeAgentId, hasRunContext, involvedToolIds, activeToolSet])

  // Detail panel for selected node
  const detailInfo = useMemo((): { title: string; lines: Array<{ label: string; value: string }>; invocations?: Array<{ args: string; result: string; status: "ok" | "error" }> } | null => {
    if (!selectedNode) return null
    if (selectedNode.startsWith("agent:")) {
      const agentId = selectedNode.slice(6)
      const agent = agents.find((a) => a.id === agentId)
      if (!agent) return null
      return {
        title: agent.name, lines: [
          { label: "Tools", value: String(agent.tools.length) },
          ...(run?.agentId === agentId ? [{ label: "Status", value: run.status }] : []),
        ],
      }
    }
    if (selectedNode.startsWith("tool:")) {
      const toolId = selectedNode.slice(5)
      const stats = toolStats.get(toolId)
      const invocations: Array<{ args: string; result: string; status: "ok" | "error" }> = []
      for (let i = 0; i < trace.length; i++) {
        const e = trace[i]
        if (e.kind === "tool-call" && e.tool === toolId) {
          const args = e.argsSummary || e.argsFormatted || "..."
          let result = "", status: "ok" | "error" = "ok"
          for (let j = i + 1; j < trace.length; j++) {
            const r = trace[j]
            if (r.kind === "tool-result") { result = r.text; break }
            else if (r.kind === "tool-error") { result = r.text; status = "error"; break }
            else if (r.kind === "tool-call") { result = "⏳ running..."; break }
          }
          if (!result) result = "⏳ running..."
          invocations.push({ args, result, status })
        }
      }
      return {
        title: mapToolLabel(toolId), lines: stats ? [
          { label: "Calls", value: String(stats.calls) },
          { label: "Errors", value: String(stats.errors) },
          { label: "Status", value: stats.lastStatus },
        ] : [{ label: "Status", value: "No activity" }],
        invocations,
      }
    }
    if (selectedNode.startsWith("delegate:")) {
      const key = selectedNode.slice(9)
      const deleg = traceDelegations.find((d) => d.key === key)
      if (!deleg) return null
      return {
        title: `Delegate D${deleg.depth}`, lines: [
          { label: "Goal", value: deleg.goal.slice(0, 60) },
          { label: "Tools", value: String(deleg.tools.length) },
          { label: "Status", value: deleg.status },
        ],
      }
    }
    return null
  }, [selectedNode, agents, run, toolStats, traceDelegations, trace])

  if (agents.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[13px]" style={{ color: C.dim }}>
        Loading agent graph...
      </div>
    )
  }

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden select-none" style={{ background: C.base }}>
      {/* Force-directed graph */}
      <div className="absolute inset-0" style={{ cursor: "grab" }}>
        <ForceGraph2D
          ref={graphRef}
          graphData={graphData}
          width={size.w}
          height={size.h}
          backgroundColor="transparent"
          nodeCanvasObject={paintNode}
          nodeCanvasObjectMode={() => "replace"}
          nodePointerAreaPaint={paintNodeArea}
          onNodeClick={handleNodeClick}
          onNodeDragEnd={handleNodeDragEnd}
          onZoom={handleZoom}
          enableNodeDrag={true}
          enableZoomInteraction={true}
          enablePanInteraction={true}
          linkCanvasObject={paintLink}
          linkCanvasObjectMode={() => "replace"}
          cooldownTicks={80}
          d3AlphaDecay={0.015}
          d3VelocityDecay={0.35}
          d3AlphaMin={0.005}
          minZoom={0.3}
          maxZoom={8}
          dagLevelDistance={80}
        />
      </div>

      {/* Zoom controls — bottom center */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-lg px-1 py-0.5" style={{ background: C.surface + "cc" }}>
        <button className="flex items-center justify-center w-6 h-6 rounded transition-colors cursor-pointer hover:bg-white/10" style={{ color: C.muted }}
          onClick={() => { const fg = graphRef.current; if (fg) fg.zoom(fg.zoom() * 0.7, 200) }}>
          <span className="text-sm">−</span>
        </button>
        <span className="text-[10px] font-mono w-8 text-center" style={{ color: C.muted }}>{zoomLevel}%</span>
        <button className="flex items-center justify-center w-6 h-6 rounded transition-colors cursor-pointer hover:bg-white/10" style={{ color: C.muted }}
          onClick={() => { const fg = graphRef.current; if (fg) fg.zoom(fg.zoom() * 1.4, 200) }}>
          <span className="text-sm">+</span>
        </button>
        <button className="flex items-center justify-center w-6 h-6 rounded transition-colors cursor-pointer hover:bg-white/10" style={{ color: C.muted }}
          onClick={() => {
            const fg = graphRef.current; if (!fg) return
            const nodes = graphData.nodes; if (nodes.length === 0) return
            let cx = 0, cy = 0
            for (const n of nodes) { cx += (n as NodeObject<MapNode>).x ?? 0; cy += (n as NodeObject<MapNode>).y ?? 0 }
            fg.centerAt(cx / nodes.length, cy / nodes.length, 400)
          }}>
          <span className="text-[11px]">⊕</span>
        </button>
      </div>

      {/* Status indicator — top left */}
      {run && (
        <div className="absolute top-3 left-3 flex items-center gap-2 rounded-lg px-3 py-1.5 text-[11px]" style={{ background: C.surface + "cc" }}>
          <span className={`w-2 h-2 rounded-full ${isRunning ? "animate-pulse" : ""}`} style={{ background: isRunning ? C.success : statusDot(run.status) }} />
          <span style={{ color: isRunning ? C.success : C.muted }}>{run.status}</span>
          {trace.length > 0 && <span style={{ color: C.dim }}>{trace.filter(e => e.kind === "tool-call").length} calls</span>}
        </div>
      )}

      {/* Detail panel — right side */}
      {selectedNode && detailInfo && (
        <div className="absolute top-3 right-3 rounded-lg px-4 py-3 font-mono max-w-[300px] max-h-[70%] flex flex-col" style={{ background: `${C.surface}ee`, border: `1px solid rgba(255,255,255,0.08)`, color: C.text }}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[13px] font-semibold" style={{ color: C.accent }}>{detailInfo.title}</span>
            <button className="opacity-40 hover:opacity-100 ml-3 leading-none text-[16px] cursor-pointer" style={{ color: C.muted }} onClick={() => setSelectedNode(null)}>×</button>
          </div>
          {detailInfo.lines.map((line, i) => (
            <div key={i} className="flex justify-between gap-4 text-[11px] leading-relaxed">
              <span style={{ color: C.muted }}>{line.label}</span>
              <span className="font-medium">{line.value}</span>
            </div>
          ))}
          {detailInfo.invocations && detailInfo.invocations.length > 0 && (
            <div className="mt-2 pt-2 overflow-y-auto flex-1 flex flex-col gap-2" style={{ borderTop: `1px solid rgba(255,255,255,0.06)` }}>
              {detailInfo.invocations.map((inv, i) => (
                <div key={i} className="text-[10px]">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: inv.status === "error" ? C.coral : inv.result === "⏳ running..." ? C.accent : C.success }} />
                    <span style={{ color: C.text }} className="font-medium">#{i + 1}</span>
                    <span style={{ color: C.muted }} className="truncate">{inv.args.length > 50 ? inv.args.slice(0, 47) + "..." : inv.args}</span>
                  </div>
                  <div className="ml-3 pl-2 leading-snug whitespace-pre-wrap break-all" style={{ color: inv.status === "error" ? C.coral : inv.result === "⏳ running..." ? C.accent : C.muted, borderLeft: `2px solid ${inv.status === "error" ? C.coral + "40" : "rgba(255,255,255,0.06)"}`, maxHeight: 80, overflow: "hidden" }}>
                    {inv.result.length > 200 ? inv.result.slice(0, 197) + "..." : inv.result}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
