/**
 * IOE editor-area panels — Trace (DAG-style), LLM Calls, Map, EditorTabs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { AgentDefinition, Run, TraceEntry } from "../../types"
import { fmtTokens, truncate } from "../../util"
import {
    C,
    fmtK,
    statusDot,
    type EditorTab,
} from "./constants"

// ═══════════════════════════════════════════════════════════════════
//  EditorTabs — tab bar for the editor area
// ═══════════════════════════════════════════════════════════════════

export function EditorTabs({
  current,
  onChange,
  trace,
}: {
  current: EditorTab
  onChange: (tab: EditorTab) => void
  trace: TraceEntry[]
}) {
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

  const llmCallCount = useMemo(() =>
    trace.filter((e) => e.kind === "llm-request").length,
    [trace],
  )

  const tabs: Array<{ id: EditorTab; label: string; count?: number }> = [
    { id: "trace", label: "Trace", count: visibleTraceCount },
    { id: "llm-calls", label: "Agent Loop", count: llmCallCount },
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

// ═══════════════════════════════════════════════════════════════════
//  TracePanel — DAG-style hierarchical trace view
// ═══════════════════════════════════════════════════════════════════

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

  // Group trace into iterations for DAG-like structure
  const groups = groupTraceByIteration(trace)

  return (
    <div ref={ref} className="h-full overflow-y-auto px-3 py-2 font-mono text-[13px] leading-relaxed">
      {groups.map((g, gi) => (
        <TraceGroup key={gi} group={g} isLast={gi === groups.length - 1} />
      ))}
    </div>
  )
}

interface TraceGroupData {
  type: "goal" | "iteration" | "answer" | "error"
  header: TraceEntry
  children: TraceEntry[]
  delegationDepth: number
}

function groupTraceByIteration(trace: TraceEntry[]): TraceGroupData[] {
  const groups: TraceGroupData[] = []
  let current: TraceGroupData | null = null
  let delegDepth = 0

  for (const e of trace) {
    if (e.kind === "goal") {
      current = { type: "goal", header: e, children: [], delegationDepth: 0 }
      groups.push(current)
    } else if (e.kind === "iteration") {
      current = { type: "iteration", header: e, children: [], delegationDepth: delegDepth }
      groups.push(current)
    } else if (e.kind === "answer") {
      groups.push({ type: "answer", header: e, children: [], delegationDepth: delegDepth })
      current = null
    } else if (e.kind === "error") {
      groups.push({ type: "error", header: e, children: [], delegationDepth: delegDepth })
      current = null
    } else {
      if (e.kind === "delegation-start") delegDepth++
      if (e.kind === "delegation-end") delegDepth = Math.max(0, delegDepth - 1)
      if (current) current.children.push(e)
    }
  }
  return groups
}

function TraceGroup({ group: g, isLast }: { group: TraceGroupData; isLast: boolean }) {
  // Goal node
  if (g.type === "goal") {
    const goalEntry = g.header as Extract<TraceEntry, { kind: "goal" }>
    return (
      <div className="relative pl-6 pb-2">
        {/* Vertical connector line */}
        <div className="absolute left-[11px] top-5 bottom-0 w-px" style={{ background: C.accent + "30" }} />
        {/* Node dot */}
        <div className="absolute left-[7px] top-1.5 w-2.5 h-2.5 rounded-full" style={{ background: C.accent }} />
        <div className="pb-1">
          <span className="text-[12px] font-mono font-semibold mr-2" style={{ color: C.accent }}>GOAL</span>
          <span className="text-[13px]" style={{ color: C.text }}>{goalEntry.text}</span>
        </div>
      </div>
    )
  }

  // Answer node
  if (g.type === "answer") {
    const ansEntry = g.header as Extract<TraceEntry, { kind: "answer" }>
    return (
      <div className="relative pl-6 pt-1 pb-2">
        <div className="absolute left-[7px] top-2.5 w-2.5 h-2.5 rounded-full" style={{ background: C.success }} />
        <div className="pt-1" style={{ borderTop: `1px dashed ${C.border}` }}>
          <span className="text-[12px] font-mono font-semibold mr-2" style={{ color: C.success }}>DONE</span>
          <div className="text-[13px] whitespace-pre-wrap leading-relaxed mt-1" style={{ color: C.textSecondary }}>{ansEntry.text}</div>
        </div>
      </div>
    )
  }

  // Error node
  if (g.type === "error") {
    const errEntry = g.header as Extract<TraceEntry, { kind: "error" }>
    return (
      <div className="relative pl-6 pt-1 pb-2">
        <div className="absolute left-[7px] top-2.5 w-2.5 h-2.5 rounded-full" style={{ background: C.coral }} />
        <div className="pt-1" style={{ borderTop: `1px dashed ${C.border}` }}>
          <span className="text-[12px] font-mono font-semibold mr-2" style={{ color: C.coral }}>FAIL</span>
          <span className="text-[13px]" style={{ color: C.coral, opacity: 0.8 }}>{errEntry.text}</span>
        </div>
      </div>
    )
  }

  // Iteration group — collapsible with children indented
  return <IterationGroup group={g} isLast={isLast} />
}

function IterationGroup({ group: g, isLast }: { group: TraceGroupData; isLast: boolean }) {
  const [collapsed, setCollapsed] = useState(false)
  const iterEntry = g.header as Extract<TraceEntry, { kind: "iteration" }>
  const indent = g.delegationDepth * 16

  // Count children by type for summary
  const toolCalls = g.children.filter((e) => e.kind === "tool-call").length
  const hasErrors = g.children.some((e) => e.kind === "tool-error")
  const usage = g.children.find((e) => e.kind === "usage") as Extract<TraceEntry, { kind: "usage" }> | undefined

  return (
    <div className="relative" style={{ marginLeft: indent }}>
      {/* Vertical line */}
      {!isLast && (
        <div className="absolute left-[11px] top-5 bottom-0 w-px" style={{ background: C.accent + "20" }} />
      )}

      {/* Iteration header node */}
      <div
        className="relative pl-6 pb-0.5 flex items-center gap-2 cursor-pointer hover:bg-white/[0.02] rounded transition-colors"
        onClick={() => setCollapsed(!collapsed)}
      >
        <div
          className="absolute left-[5px] top-1 w-3.5 h-3.5 rounded-sm flex items-center justify-center"
          style={{ background: hasErrors ? C.coral + "20" : C.accent + "15", border: `1px solid ${hasErrors ? C.coral + "40" : C.accent + "30"}` }}
        >
          <span className="text-[9px] font-bold" style={{ color: hasErrors ? C.coral : C.accent }}>
            {iterEntry.current}
          </span>
        </div>
        <span className="text-[12px] font-mono" style={{ color: C.muted }}>
          ITER {iterEntry.current}/{iterEntry.max}
        </span>
        {toolCalls > 0 && (
          <span className="text-[12px] font-mono" style={{ color: C.warning }}>{toolCalls} tool{toolCalls > 1 ? "s" : ""}</span>
        )}
        {usage && (
          <span className="text-[12px] font-mono" style={{ color: C.dim }}>+{fmtK(usage.iterationTokens)} tk</span>
        )}
        <span className="text-[10px] ml-auto" style={{ color: C.dim }}>
          {collapsed ? "▸" : "▾"}
        </span>
      </div>

      {/* Children — tool calls, thinking, results, delegation — indented under the iteration  */}
      {!collapsed && (
        <div className="pl-6 ml-0.5" style={{ borderLeft: `1px solid ${C.accent}15`, marginLeft: 10 }}>
          {g.children.map((e, i) => (
            <TraceChild key={i} entry={e} />
          ))}
        </div>
      )}
    </div>
  )
}

function TraceChild({ entry: e }: { entry: TraceEntry }) {
  const [expanded, setExpanded] = useState(false)

  if (e.kind === "thinking") {
    return (
      <div className="py-0.5 pl-2" style={{ borderLeft: `2px solid ${C.accent}30` }}>
        <span className="text-[12px] font-mono font-semibold mr-1.5" style={{ color: C.accent }}>LLM</span>
        <span className="text-[13px] whitespace-pre-wrap" style={{ color: C.textSecondary }}>{e.text}</span>
      </div>
    )
  }
  if (e.kind === "tool-call") {
    return (
      <div className="py-0.5">
        <div
          className="flex items-center gap-1.5 cursor-pointer hover:bg-white/[0.02] rounded px-1 -mx-1 transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: C.warning }} />
          <span className="text-[12px] font-mono font-semibold" style={{ color: C.warning }}>CALL</span>
          <span className="text-[13px] font-mono" style={{ color: C.warning }}>{e.tool}</span>
          {!expanded && e.argsSummary && (
            <span className="text-[13px] truncate" style={{ color: C.dim }}>{e.argsSummary}</span>
          )}
          <span className="text-[10px] ml-auto" style={{ color: C.dim }}>{expanded ? "▾" : "▸"}</span>
        </div>
        {expanded && (
          <pre
            className="text-[12px] rounded-lg p-2 mt-1 ml-3 max-h-40 overflow-auto whitespace-pre-wrap"
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
          className="flex items-center gap-1.5 cursor-pointer hover:bg-white/[0.02] rounded px-1 -mx-1 transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          <span className="w-1 h-1 rounded-full shrink-0" style={{ background: C.success + "80" }} />
          <span className="text-[12px] font-mono font-semibold" style={{ color: C.success }}>RSLT</span>
          {!expanded && (
            <span className="text-[13px] truncate" style={{ color: C.muted }}>
              {e.text.length > 100 ? e.text.slice(0, 100) + "..." : e.text}
            </span>
          )}
        </div>
        {expanded && (
          <pre
            className="text-[12px] rounded-lg p-2 mt-1 ml-3 max-h-40 overflow-auto whitespace-pre-wrap"
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
        <span className="w-1 h-1 rounded-full inline-block mr-1.5" style={{ background: C.coral }} />
        <span className="text-[12px] font-mono font-semibold mr-1" style={{ color: C.coral }}>ERR</span>
        <span className="text-[13px]" style={{ color: C.coral, opacity: 0.8 }}>{e.text}</span>
      </div>
    )
  }
  if (e.kind === "usage") {
    return (
      <div className="flex items-center gap-3 py-0.5 text-[12px] font-mono" style={{ color: C.dim }}>
        <span>+{fmtK(e.iterationTokens)} tk (total {fmtK(e.totalTokens)})</span>
        <span>{e.llmCalls} calls</span>
      </div>
    )
  }
  if (e.kind === "delegation-start") {
    return (
      <div className="py-1 pl-2 mt-0.5" style={{ borderLeft: `2px solid #6CB4EE40` }}>
        <div className="flex items-center gap-1.5">
          <span className="text-[12px] font-mono font-semibold" style={{ color: "#6CB4EE" }}>DELEG ▶</span>
          {e.agentName && <span className="text-[13px]" style={{ color: C.textSecondary }}>[{e.agentName}]</span>}
          <span className="text-[12px] font-mono" style={{ color: C.dim }}>d{e.depth}</span>
        </div>
        <div className="text-[13px] mt-0.5 pl-2" style={{ color: C.textSecondary }}>
          {e.goal.length > 200 ? e.goal.slice(0, 200) + "..." : e.goal}
        </div>
        <div className="text-[12px] font-mono mt-0.5 pl-2" style={{ color: C.dim }}>
          tools: {e.tools.slice(0, 6).join(", ")}{e.tools.length > 6 ? ` +${e.tools.length - 6}` : ""}
        </div>
      </div>
    )
  }
  if (e.kind === "delegation-end") {
    return (
      <div className="py-1 pl-2 mb-0.5" style={{ borderLeft: `2px solid #6CB4EE40` }}>
        <span className="text-[12px] font-mono font-semibold mr-1.5" style={{ color: "#6CB4EE" }}>DELEG ◀</span>
        <span className="text-[12px] font-mono" style={{ color: e.status === "done" ? C.success : C.coral }}>{e.status}</span>
        {e.answer && (
          <div className="text-[13px] mt-0.5 pl-2" style={{ color: C.textSecondary }}>
            {e.answer.length > 150 ? e.answer.slice(0, 150) + "..." : e.answer}
          </div>
        )}
        {e.error && (
          <div className="text-[13px] mt-0.5 pl-2" style={{ color: C.coral }}>{e.error}</div>
        )}
      </div>
    )
  }
  if (e.kind === "delegation-iteration") {
    return (
      <div className="text-[12px] font-mono pl-4 py-0.5" style={{ color: C.dim }}>
        ↳ ITER {e.iteration}/{e.maxIterations}
      </div>
    )
  }
  if (e.kind === "delegation-parallel-start") {
    return (
      <div className="py-1 pl-2 mt-0.5" style={{ borderLeft: `2px solid #6CB4EE40` }}>
        <span className="text-[12px] font-mono font-semibold mr-1.5" style={{ color: "#6CB4EE" }}>PARLL ▶</span>
        <span className="text-[12px] font-mono" style={{ color: C.muted }}>{e.taskCount} tasks</span>
        {e.goals.map((goal, i) => (
          <div key={i} className="pl-4 text-[13px]" style={{ color: C.muted }}>• {truncate(goal, 80)}</div>
        ))}
      </div>
    )
  }
  if (e.kind === "delegation-parallel-end") {
    return (
      <div className="py-0.5 pl-2 mb-0.5" style={{ borderLeft: `2px solid #6CB4EE40` }}>
        <span className="text-[12px] font-mono font-semibold mr-1.5" style={{ color: "#6CB4EE" }}>PARLL ◀</span>
        <span className="text-[12px] font-mono" style={{ color: C.muted }}>{e.fulfilled}/{e.taskCount} ok, {e.rejected} failed</span>
      </div>
    )
  }
  if (e.kind === "user-input-request") {
    return (
      <div className="py-0.5 pl-2" style={{ borderLeft: `2px solid ${C.warning}40` }}>
        <span className="text-[12px] font-mono font-semibold mr-1.5" style={{ color: C.warning }}>ASK</span>
        <span className="text-[13px]" style={{ color: C.text }}>{e.question}</span>
      </div>
    )
  }
  if (e.kind === "user-input-response") {
    return (
      <div className="py-0.5 pl-2" style={{ borderLeft: `2px solid ${C.warning}40` }}>
        <span className="text-[12px] font-mono font-semibold mr-1.5" style={{ color: C.success }}>REPLY</span>
        <span className="text-[13px]" style={{ color: C.textSecondary }}>{e.text}</span>
      </div>
    )
  }
  return null
}

// ═══════════════════════════════════════════════════════════════════
//  LlmCallsPanel — DebugInspector's LLM Calls view embedded
// ═══════════════════════════════════════════════════════════════════

export function LlmCallsPanel({ trace }: { trace: TraceEntry[] }) {
  const llmCalls = useMemo(() => {
    const requests = trace.filter((e) => e.kind === "llm-request") as Array<Extract<TraceEntry, { kind: "llm-request" }>>
    const responses = trace.filter((e) => e.kind === "llm-response") as Array<Extract<TraceEntry, { kind: "llm-response" }>>
    return requests.map((req, i) => ({ request: req, response: responses[i] ?? null }))
  }, [trace])

  if (llmCalls.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[13px]" style={{ color: C.dim }}>
        No iteration data yet — start a run
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto px-3 py-2 space-y-2 text-[13px]">
      {/* Stats summary */}
      <div className="flex items-center gap-3 flex-wrap text-[12px] font-mono" style={{ color: C.muted }}>
        <span>
          <span style={{ color: "#6CB4EE" }}>iterations</span> {llmCalls.length}
          {llmCalls.length > 0 && ` · ${Math.round(llmCalls.reduce((s, c) => s + (c.response?.durationMs ?? 0), 0) / Math.max(1, llmCalls.filter(c => c.response).length))}ms avg`}
        </span>
      </div>

      {/* LLM Calls */}
      {llmCalls.map((call, i) => (
        <LlmCallCard key={i} index={i} request={call.request} response={call.response} />
      ))}
    </div>
  )
}

const ROLE_COLORS: Record<string, string> = {
  system: C.accent,
  user: C.success,
  assistant: C.warning,
  tool: "#6CB4EE",
}

function LlmCallCard({
  index, request: req, response: res,
}: {
  index: number
  request: Extract<TraceEntry, { kind: "llm-request" }>
  response: Extract<TraceEntry, { kind: "llm-response" }> | null
}) {
  const [showMessages, setShowMessages] = useState(false)

  const durationColor = res
    ? res.durationMs > 5000 ? C.coral : res.durationMs > 2000 ? C.warning : C.success
    : C.dim

  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 6, overflow: "hidden" }}>
      {/* Header */}
      <div
        className="flex items-center gap-3 px-3 py-1.5 cursor-pointer hover:bg-white/[0.03] transition-colors"
        style={{ background: C.elevated + "20" }}
        onClick={() => setShowMessages(!showMessages)}
      >
        <span className="text-[13px] font-semibold" style={{ color: "#6CB4EE" }}>#{index + 1}</span>
        <span className="text-[12px] font-mono" style={{ color: C.muted }}>
          iter {req.iteration + 1}
        </span>
        <span className="text-[12px]" style={{ color: C.dim }}>
          {req.messageCount} msgs → {res ? (res.toolCalls.length > 0 ? `${res.toolCalls.length} tool calls` : "text") : "pending..."}
        </span>
        {res && (
          <span className="text-[12px] font-mono ml-auto" style={{ color: durationColor }}>{res.durationMs}ms</span>
        )}
        {res?.usage && (
          <span className="text-[11px] font-mono" style={{ color: C.dim }}>
            {fmtK(res.usage.totalTokens)} tk
          </span>
        )}
      </div>

      {showMessages && (
        <>
          {/* Request messages */}
          <div className="px-3 py-2" style={{ borderTop: `1px solid ${C.border}` }}>
            <div className="text-[11px] uppercase tracking-wide mb-1" style={{ color: C.dim }}>
              Request — {req.messageCount} messages, {req.toolCount} tools
            </div>
            <div className="space-y-1 max-h-[300px] overflow-y-auto">
              {req.messages.map((msg, mi) => (
                <LlmMessage key={mi} msg={msg} index={mi} />
              ))}
            </div>
          </div>

          {/* Response */}
          {res && (
            <div className="px-3 py-2" style={{ borderTop: `1px solid ${C.border}`, background: C.elevated + "10" }}>
              <div className="flex items-center gap-3 mb-1">
                <span className="text-[11px] uppercase tracking-wide" style={{ color: C.dim }}>Response</span>
                {res.usage && (
                  <span className="text-[11px] font-mono" style={{ color: C.dim }}>
                    {fmtTokens(res.usage.promptTokens)} prompt + {fmtTokens(res.usage.completionTokens)} compl = {fmtTokens(res.usage.totalTokens)}
                  </span>
                )}
              </div>
              {res.content && (
                <pre className="text-[12px] whitespace-pre-wrap break-words leading-relaxed mb-1" style={{ color: C.textSecondary }}>
                  {res.content}
                </pre>
              )}
              {res.toolCalls.length > 0 && (
                <div className="space-y-1">
                  {res.toolCalls.map((tc) => (
                    <div key={tc.id} className="rounded px-2 py-1" style={{ background: C.warning + "08", border: `1px solid ${C.warning}15` }}>
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] font-mono font-semibold" style={{ color: C.warning }}>{tc.name}</span>
                        <span className="text-[11px] font-mono" style={{ color: C.dim }}>{tc.id.slice(0, 12)}</span>
                      </div>
                      <pre className="text-[11px] font-mono whitespace-pre-wrap break-words mt-0.5" style={{ color: C.muted }}>
                        {JSON.stringify(tc.arguments, null, 2)}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
              {res.toolCalls.length === 0 && res.content && (
                <div className="text-[11px] mt-1" style={{ color: C.success + "80" }}>↳ Final answer (no tool calls)</div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function LlmMessage({ msg, index }: {
  msg: { role: string; content: string | null; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; toolCallId: string | null }
  index: number
}) {
  const [expanded, setExpanded] = useState(false)
  const isLong = (msg.content?.length ?? 0) > 300
  const displayContent = expanded || !isLong ? msg.content : msg.content!.slice(0, 300) + "..."

  return (
    <div className="pl-2 py-0.5" style={{ borderLeft: `2px solid ${ROLE_COLORS[msg.role] ?? C.dim}` }}>
      <div className="flex items-center gap-2 mb-0.5">
        <span className="text-[11px] font-mono font-bold uppercase" style={{ color: ROLE_COLORS[msg.role] ?? C.dim }}>{msg.role}</span>
        <span className="text-[10px]" style={{ color: C.dim }}>#{index}</span>
        {msg.toolCallId && <span className="text-[10px] font-mono" style={{ color: C.dim }}>← {msg.toolCallId.slice(0, 12)}</span>}
        {msg.content && <span className="text-[10px]" style={{ color: C.dim }}>{msg.content.length} chars</span>}
      </div>
      {displayContent && (
        <pre
          className="text-[12px] whitespace-pre-wrap break-words leading-relaxed cursor-pointer"
          style={{ color: C.textSecondary }}
          onClick={() => setExpanded(!expanded)}
        >
          {displayContent}
        </pre>
      )}
      {isLong && !expanded && (
        <button className="text-[11px] mt-0.5 cursor-pointer" style={{ color: C.accent + "60" }} onClick={() => setExpanded(true)}>
          show full ({msg.content!.length} chars)
        </button>
      )}
      {msg.toolCalls.length > 0 && (
        <div className="mt-1 space-y-1">
          {msg.toolCalls.map((tc) => (
            <div key={tc.id} className="rounded px-2 py-1" style={{ background: C.warning + "08", border: `1px solid ${C.warning}10` }}>
              <span className="text-[11px] font-mono font-semibold" style={{ color: C.warning }}>{tc.name}</span>
              <pre className="text-[11px] font-mono whitespace-pre-wrap break-words mt-0.5" style={{ color: C.muted }}>
                {JSON.stringify(tc.arguments, null, 2)}
              </pre>
            </div>
          ))}
        </div>
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
      const delegIndex = traceDelegations.indexOf(deleg)
      nodes.push({
        id: delegId, type: "delegate", label: `D${delegIndex + 1}`, color,
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
