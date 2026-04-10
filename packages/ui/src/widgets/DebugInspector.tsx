/**
 * DebugInspector — the "why did the agent do that?" widget.
 *
 * Shows what no other widget shows:
 *   - The FULL system prompt the LLM received (every character)
 *   - Every tool available to the agent with full parameter schemas
 *   - The COMPLETE message array sent in each LLM call
 *   - The FULL LLM response: content + tool calls with arguments
 *   - Token usage per call
 *
 * This is not a duplicate of Agent Trace — Trace shows WHAT happened,
 * this shows the raw inputs/outputs that explain WHY.
 */

import { ChevronDown, ChevronRight, Clock, Copy, Search } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useStore } from "../store"
import type { TraceEntry } from "../types"
import { fmtTokens } from "../util"

// ── Helpers ─────────────────────────────────────────────────────

const ROLE_COLORS: Record<string, string> = {
  system: "text-accent",
  user: "text-success",
  assistant: "text-warning",
  tool: "text-[#6CB4EE]",
}

function copyText(text: string) {
  navigator.clipboard.writeText(text)
}

// ── Collapsible section ─────────────────────────────────────────

function Section({
  label,
  badge,
  badgeColor = "text-text-muted",
  defaultOpen = false,
  copyable,
  children,
}: {
  label: string
  badge?: string
  badgeColor?: string
  defaultOpen?: boolean
  copyable?: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border border-border/50 rounded-lg overflow-hidden">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-left bg-elevated/30 hover:bg-elevated/50 transition-colors"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={14} className="text-text-muted shrink-0" /> : <ChevronRight size={14} className="text-text-muted shrink-0" />}
        <span className="text-[13px] font-medium text-text">{label}</span>
        {badge && <span className={`text-[13px] font-mono ml-auto ${badgeColor}`}>{badge}</span>}
      </button>
      {open && (
        <div className="px-3 py-2 border-t border-border/30 relative">
          {copyable && (
            <button
              className="absolute top-2 right-2 p-1 rounded hover:bg-elevated/50 text-text-muted/40 hover:text-text-muted transition-colors"
              onClick={(e) => { e.stopPropagation(); copyText(copyable) }}
              title="Copy to clipboard"
            >
              <Copy size={12} />
            </button>
          )}
          {children}
        </div>
      )}
    </div>
  )
}

// ── Message renderer (used in LLM request/response) ─────────────

function MessageBubble({ msg, index }: {
  msg: { role: string; content: string | null; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; toolCallId: string | null }
  index: number
}) {
  const [expanded, setExpanded] = useState(false)
  const isLong = (msg.content?.length ?? 0) > 300
  const displayContent = expanded || !isLong ? msg.content : msg.content!.slice(0, 300) + "..."

  return (
    <div className="border-l-2 pl-2 py-1" style={{ borderColor: msg.role === "system" ? "var(--accent)" : msg.role === "user" ? "var(--success, #4ade80)" : msg.role === "assistant" ? "var(--warning, #facc15)" : "var(--info, #6CB4EE)" }}>
      <div className="flex items-center gap-2 mb-0.5">
        <span className={`text-[13px] font-mono font-bold uppercase ${ROLE_COLORS[msg.role] ?? "text-text-muted"}`}>
          {msg.role}
        </span>
        <span className="text-[12px] text-text-muted/30">#{index}</span>
        {msg.toolCallId && (
          <span className="text-[12px] text-text-muted/40 font-mono">← {msg.toolCallId.slice(0, 12)}</span>
        )}
        {msg.content && (
          <span className="text-[12px] text-text-muted/30">{msg.content.length} chars</span>
        )}
      </div>

      {displayContent && (
        <pre
          className="text-[13px] font-mono text-text-secondary whitespace-pre-wrap break-words leading-relaxed cursor-pointer"
          onClick={() => setExpanded(!expanded)}
        >
          {displayContent}
        </pre>
      )}

      {isLong && !expanded && (
        <button className="text-[12px] text-accent/60 hover:text-accent mt-0.5" onClick={() => setExpanded(true)}>
          show full ({msg.content!.length} chars)
        </button>
      )}

      {!msg.content && msg.toolCalls.length === 0 && (
        <span className="text-[13px] text-text-muted/30 italic">null</span>
      )}

      {msg.toolCalls.length > 0 && (
        <div className="mt-1 space-y-1">
          {msg.toolCalls.map((tc) => (
            <div key={tc.id} className="bg-warning/5 border border-warning/10 rounded px-2 py-1">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-mono font-semibold text-warning">{tc.name}</span>
                <span className="text-[12px] text-text-muted/30 font-mono">{tc.id.slice(0, 12)}</span>
              </div>
              <pre className="text-[13px] font-mono text-text-muted whitespace-pre-wrap break-words mt-0.5">
                {JSON.stringify(tc.arguments, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Tool definition renderer ────────────────────────────────────

function ToolDefinition({ tool }: {
  tool: { name: string; description: string; parameters?: Record<string, unknown> }
}) {
  const [showSchema, setShowSchema] = useState(false)
  return (
    <div className="border border-border/30 rounded px-2 py-1.5">
      <div className="flex items-start gap-2">
        <span className="text-[13px] font-mono font-semibold text-warning shrink-0">{tool.name}</span>
        <span className="text-[13px] text-text-muted flex-1">{tool.description}</span>
      </div>
      {tool.parameters && (
        <>
          <button
            className="text-[12px] text-accent/50 hover:text-accent mt-1"
            onClick={() => setShowSchema(!showSchema)}
          >
            {showSchema ? "hide schema" : "show parameter schema"}
          </button>
          {showSchema && (
            <pre className="text-[13px] font-mono text-text-muted/60 whitespace-pre-wrap mt-1 max-h-[200px] overflow-y-auto">
              {JSON.stringify(tool.parameters, null, 2)}
            </pre>
          )}
        </>
      )}
    </div>
  )
}

// ── Main widget ─────────────────────────────────────────────────

type FilterKind = "all" | "llm" | "tools" | "prompt"

export function DebugInspector() {
  const trace = useStore((s) => s.trace)
  const activeRunId = useStore((s) => s.activeRunId)
  const [filter, setFilter] = useState<FilterKind>("llm")
  const [search, setSearch] = useState("")
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when trace updates
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [trace.length])

  // Extract the 4 debug entry types
  const systemPrompt = useMemo(
    () => trace.find((e) => e.kind === "system-prompt") as Extract<TraceEntry, { kind: "system-prompt" }> | undefined,
    [trace],
  )
  const toolsResolved = useMemo(
    () => trace.find((e) => e.kind === "tools-resolved") as Extract<TraceEntry, { kind: "tools-resolved" }> | undefined,
    [trace],
  )
  const llmCalls = useMemo(() => {
    const requests = trace.filter((e) => e.kind === "llm-request") as Array<Extract<TraceEntry, { kind: "llm-request" }>>
    const responses = trace.filter((e) => e.kind === "llm-response") as Array<Extract<TraceEntry, { kind: "llm-response" }>>
    // Pair request[i] with response[i]
    return requests.map((req, i) => ({
      request: req,
      response: responses[i] ?? null,
    }))
  }, [trace])

  // Summary stats
  const stats = useMemo(() => {
    const totalDuration = llmCalls.reduce((sum, c) => sum + (c.response?.durationMs ?? 0), 0)
    const answered = llmCalls.filter((c) => c.response)
    return {
      promptLen: systemPrompt?.text.length ?? 0,
      toolCount: toolsResolved?.tools.length ?? 0,
      callCount: llmCalls.length,
      totalDuration,
      avgDuration: answered.length > 0 ? Math.round(totalDuration / answered.length) : 0,
    }
  }, [systemPrompt, toolsResolved, llmCalls])

  // Search filter
  const matchesSearch = useCallback((text: string) => {
    if (!search) return true
    return text.toLowerCase().includes(search.toLowerCase())
  }, [search])

  const hasDebugData = systemPrompt || toolsResolved || llmCalls.length > 0

  return (
    <div className="flex flex-col h-full gap-2">
      {/* Stats bar */}
      <div className="flex items-center gap-3 shrink-0 flex-wrap">
        <div className="flex items-center gap-1.5 text-[13px] font-mono text-text-muted bg-elevated/50 px-2 py-1 rounded">
          <span className="text-accent">prompt</span> {stats.promptLen > 0 ? `${(stats.promptLen / 1000).toFixed(1)}k` : "—"}
        </div>
        <div className="flex items-center gap-1.5 text-[13px] font-mono text-text-muted bg-elevated/50 px-2 py-1 rounded">
          <span className="text-warning">tools</span> {stats.toolCount}
        </div>
        <div className="flex items-center gap-1.5 text-[13px] font-mono text-text-muted bg-elevated/50 px-2 py-1 rounded">
          <span className="text-[#6CB4EE]">llm</span> {stats.callCount} calls · {stats.avgDuration}ms avg
        </div>
        <div className="flex items-center gap-1.5 text-[13px] font-mono text-text-muted bg-elevated/50 px-2 py-1 rounded">
          <Clock size={12} /> {stats.totalDuration}ms total
        </div>
      </div>

      {/* Filter + search */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="flex items-center gap-1 bg-elevated/30 rounded-lg p-0.5">
          {([
            ["all", "All"],
            ["prompt", "Prompt"],
            ["tools", "Tools"],
            ["llm", "LLM Calls"],
          ] as [FilterKind, string][]).map(([key, label]) => (
            <button
              key={key}
              className={`px-2.5 py-1 text-[13px] font-medium rounded-md transition-colors ${
                filter === key ? "bg-accent/20 text-accent" : "text-text-muted hover:text-text"
              }`}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 flex-1 ml-auto bg-elevated/30 rounded-lg px-2 py-1">
          <Search size={14} className="text-text-muted/50 shrink-0" />
          <input
            type="text"
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-transparent text-[13px] text-text w-full outline-none placeholder:text-text-muted/30"
          />
        </div>
      </div>

      {/* Main content */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-2 pr-1">
        {!activeRunId && (
          <div className="text-text-muted text-center pt-8 text-sm">Select a run to inspect</div>
        )}

        {activeRunId && !hasDebugData && (
          <div className="text-text-muted text-center pt-8 text-sm">
            {trace.length === 0
              ? "No trace data yet — start an agent run"
              : "No debug entries found — run may predate debug instrumentation"}
          </div>
        )}

        {/* ── System Prompt ── */}
        {(filter === "all" || filter === "prompt") && systemPrompt && matchesSearch(systemPrompt.text) && (
          <Section
            label="System Prompt"
            badge={`${systemPrompt.text.length.toLocaleString()} chars`}
            badgeColor="text-accent/70"
            copyable={systemPrompt.text}
          >
            <pre className="text-[13px] font-mono text-text-secondary whitespace-pre-wrap leading-relaxed max-h-[500px] overflow-y-auto">
              {systemPrompt.text}
            </pre>
          </Section>
        )}

        {/* ── Tools Available ── */}
        {(filter === "all" || filter === "tools") && toolsResolved && (
          <Section
            label="Tools Available to Agent"
            badge={`${toolsResolved.tools.length} tools`}
            badgeColor="text-warning/70"
            defaultOpen
          >
            <div className="space-y-1.5">
              {toolsResolved.tools
                .filter((t) => matchesSearch(`${t.name} ${t.description}`))
                .map((t) => (
                  <ToolDefinition key={t.name} tool={t} />
                ))}
            </div>
          </Section>
        )}

        {/* ── LLM Calls ── */}
        {(filter === "all" || filter === "llm") && llmCalls.map((call, i) => {
          const req = call.request
          const res = call.response

          // Search: match against messages content or tool call names
          if (search) {
            const blob = JSON.stringify(req) + JSON.stringify(res)
            if (!blob.toLowerCase().includes(search.toLowerCase())) return null
          }

          return (
            <LlmCallEntry key={i} call={call} index={i} />
          )
        })}
      </div>
    </div>
  )
}

/** Collapsible LLM call entry — click header to expand/collapse */
function LlmCallEntry({ call, index }: {
  call: { request: Extract<TraceEntry, { kind: "llm-request" }>; response: Extract<TraceEntry, { kind: "llm-response" }> | null }
  index: number
}) {
  const [open, setOpen] = useState(false)
  const req = call.request
  const res = call.response

  return (
    <div className="border border-border/40 rounded-lg overflow-hidden">
      {/* Clickable call header */}
      <button
        className="flex items-center gap-3 px-3 py-2 bg-elevated/20 w-full text-left cursor-pointer hover:bg-elevated/40 transition-colors"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={14} className="text-text-muted shrink-0" /> : <ChevronRight size={14} className="text-text-muted shrink-0" />}
        <span className="text-[14px] font-semibold text-[#6CB4EE]">LLM Call #{index + 1}</span>
        <span className="text-[13px] font-mono text-text-muted">
          iteration {req.iteration + 1}
        </span>
        <span className="text-[13px] font-mono text-text-muted">
          {req.messageCount} msgs → LLM → {res ? (res.toolCalls.length > 0 ? `${res.toolCalls.length} tool calls` : "text response") : "pending..."}
        </span>
        {res && (
          <span className={`text-[13px] font-mono ml-auto ${res.durationMs > 5000 ? "text-error" : res.durationMs > 2000 ? "text-warning" : "text-success"}`}>
            {res.durationMs}ms
          </span>
        )}
      </button>

      {/* Collapsible body */}
      {open && (
        <>
          {/* Request: full message array */}
          <div className="px-3 py-2 border-t border-border/20">
            <div className="text-[12px] font-medium text-text-muted/50 uppercase tracking-wider mb-1.5">
              Request — {req.messageCount} messages, {req.toolCount} tool definitions
            </div>
            <div className="space-y-1.5 max-h-[400px] overflow-y-auto">
              {req.messages.map((msg, mi) => (
                <MessageBubble key={mi} msg={msg} index={mi} />
              ))}
            </div>
          </div>

          {/* Response */}
          {res && (
            <div className="px-3 py-2 border-t border-border/20 bg-elevated/10">
              <div className="flex items-center gap-3 mb-1.5">
                <span className="text-[12px] font-medium text-text-muted/50 uppercase tracking-wider">Response</span>
                {res.usage && (
                  <span className="text-[13px] font-mono text-text-muted/40">
                    {fmtTokens(res.usage.promptTokens)} prompt + {fmtTokens(res.usage.completionTokens)} completion = {fmtTokens(res.usage.totalTokens)} total
                  </span>
                )}
              </div>

              {/* Response content */}
              {res.content && (
                <div className="mb-2">
                  <div className="text-[12px] text-text-muted/40 mb-0.5">content:</div>
                  <pre className="text-[13px] font-mono text-text-secondary whitespace-pre-wrap break-words leading-relaxed">
                    {res.content}
                  </pre>
                </div>
              )}

              {/* Response tool calls */}
              {res.toolCalls.length > 0 && (
                <div>
                  <div className="text-[12px] text-text-muted/40 mb-0.5">tool calls:</div>
                  <div className="space-y-1">
                    {res.toolCalls.map((tc) => (
                      <div key={tc.id} className="bg-warning/5 border border-warning/10 rounded px-2 py-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-mono font-semibold text-warning">{tc.name}</span>
                          <span className="text-[12px] text-text-muted/30 font-mono">{tc.id}</span>
                        </div>
                        <pre className="text-[13px] font-mono text-text-muted whitespace-pre-wrap break-words mt-0.5">
                          {JSON.stringify(tc.arguments, null, 2)}
                        </pre>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* No tool calls and no content = weird */}
              {res.toolCalls.length === 0 && !res.content && (
                <div className="text-[13px] text-error/50 italic">Empty response — no content and no tool calls</div>
              )}

              {/* Final answer indicator */}
              {res.toolCalls.length === 0 && res.content && (
                <div className="text-[13px] text-success/60 mt-1">↳ No tool calls — this became the final answer</div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
