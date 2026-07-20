/**
 * Trace — review what the agent sent to the model and what it replied.
 *
 * Mental model (chat, not a debug dump):
 *   each Call = one model round-trip (iteration)
 *   · Sent to model  — history the LLM saw (collapsible)
 *   · Agent replied  — the answer for that round (text and/or tool calls)
 *
 * Tool *results* live in history. Tool *calls* are part of the agent reply —
 * never a separate “TOOL” speaker for the response.
 */

import { ChevronDown, ChevronRight, Copy, Search } from "lucide-react"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { EmptyState } from "../components/EmptyState"
import { JsonViewer } from "../components/JsonViewer"
import { fmtTokens, formatMs } from "../lib/util"
import { useStore } from "../state/store"
import type { TraceEntry } from "../types"
import { WIDGET_ICONS } from "./widget-icons"

// ── Types ────────────────────────────────────────────────────────

type LlmRequest = Extract<TraceEntry, { kind: "llm-request" }>
type LlmResponse = Extract<TraceEntry, { kind: "llm-response" }>
type SystemPrompt = Extract<TraceEntry, { kind: "system-prompt" }>
type ToolsResolved = Extract<TraceEntry, { kind: "tools-resolved" }>
type SqlQuality = Extract<TraceEntry, { kind: "planner-sql-quality" }>

type TraceMessage = LlmRequest["messages"][number]
type LlmCall = { request: LlmRequest; response: LlmResponse | null }
type FilterKind = "calls" | "context" | "all"
type PartsMode = "collapsed" | "expanded"

// ── Labels (product language, not API roles) ─────────────────────

function historySpeaker(role: string): string {
  if (role === "assistant") return "Agent"
  if (role === "system") return "System"
  if (role === "user") return "User"
  if (role === "tool") return "Tool result"
  return role
}

function formatCharCount(n: number): string {
  return n.toLocaleString()
}

function copyText(text: string) {
  navigator.clipboard.writeText(text)
}

/** Pair each request with its response by iteration (positional fallback). */
function pairLlmCalls(trace: TraceEntry[]): LlmCall[] {
  const requests = trace.filter((e): e is LlmRequest => e.kind === "llm-request")
  const responses = trace.filter((e): e is LlmResponse => e.kind === "llm-response")
  const responseByIter = new Map<number, LlmResponse>()
  for (const response of responses) {
    if (!responseByIter.has(response.iteration)) {
      responseByIter.set(response.iteration, response)
    }
  }
  return requests.map((request, i) => ({
    request,
    response: responseByIter.get(request.iteration) ?? responses[i] ?? null,
  }))
}

function replyHeadline(res: LlmResponse | null): string {
  if (!res) return "Waiting for reply…"
  if (res.toolCalls.length > 0 && res.content) {
    return `Called ${res.toolCalls.length} tool${res.toolCalls.length === 1 ? "" : "s"} · with text`
  }
  if (res.toolCalls.length > 0) {
    const names = res.toolCalls.map((t) => t.name)
    if (names.length <= 2) return `Called ${names.join(", ")}`
    return `Called ${names.slice(0, 2).join(", ")} +${names.length - 2}`
  }
  if (res.content) return "Final answer"
  return "Empty reply"
}

function messagePreview(msg: TraceMessage): string {
  if (msg.toolCalls.length > 0) {
    return `called ${msg.toolCalls.map((t) => t.name).join(", ")}`
  }
  if (msg.content) {
    const line = msg.content.replace(/\s+/g, " ").trim()
    return line.length > 100 ? `${line.slice(0, 99)}…` : line
  }
  if (msg.toolCallId) return `for ${msg.toolCallId.slice(0, 12)}`
  return "empty"
}

function tokensInOut(usage: {
  promptTokens: number
  completionTokens: number
  totalTokens: number
} | null): string | null {
  if (!usage) return null
  return `${fmtTokens(usage.promptTokens)} in · ${fmtTokens(usage.completionTokens)} out · ${fmtTokens(usage.totalTokens)} total`
}

// ── Expandable text ──────────────────────────────────────────────

const TEXT_PREVIEW_CHARS = 400

function ExpandableText({
  text,
  className = "trace-chat-body whitespace-pre-wrap break-words",
  previewChars = TEXT_PREVIEW_CHARS,
  maxExpandedHeight,
}: {
  text: string
  className?: string
  previewChars?: number
  maxExpandedHeight?: number
}) {
  const [expanded, setExpanded] = useState(false)
  const isLong = text.length > previewChars

  useEffect(() => {
    setExpanded(false)
  }, [text])

  const display = !isLong || expanded ? text : `${text.slice(0, previewChars)}…`

  return (
    <div className="min-w-0">
      <pre
        className={className}
        style={
          expanded && maxExpandedHeight
            ? { maxHeight: maxExpandedHeight, overflowY: "auto" }
            : undefined
        }
      >
        {display}
      </pre>
      {isLong && (
        <button
          type="button"
          className="trace-expand-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded
            ? "Show less"
            : `Show more · ${formatCharCount(text.length)} chars`}
        </button>
      )}
    </div>
  )
}

// ── Collapsible section (context) ────────────────────────────────

function Section({
  label,
  badge,
  defaultOpen = false,
  copyable,
  children,
}: {
  label: string
  badge?: string
  defaultOpen?: boolean
  copyable?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="debug-trace-block shrink-0 rounded-lg border border-border/50 overflow-clip">
      <button
        type="button"
        className="flex items-center gap-2 w-full px-3 py-2.5 text-left bg-elevated/30 hover:bg-elevated/50 transition-colors"
        onClick={() => setOpen(!open)}
      >
        {open ? (
          <ChevronDown size={16} className="text-text-muted shrink-0" />
        ) : (
          <ChevronRight size={16} className="text-text-muted shrink-0" />
        )}
        <span className="text-base font-medium text-text">{label}</span>
        {badge && (
          <span className="text-sm font-mono text-text-muted ml-auto">{badge}</span>
        )}
      </button>
      {open && (
        <div className="px-3 py-2.5 border-t border-border/30 relative">
          {copyable && (
            <button
              type="button"
              className="absolute top-2 right-2 p-1 rounded hover:bg-elevated/50 text-text-muted/40 hover:text-text-muted transition-colors"
              onClick={(e) => {
                e.stopPropagation()
                copyText(copyable)
              }}
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

// ── History message (sent to model) ──────────────────────────────

function HistoryMessage({
  msg,
  partsMode,
}: {
  msg: TraceMessage
  partsMode: PartsMode
}) {
  const [open, setOpen] = useState(partsMode === "expanded")

  useEffect(() => {
    setOpen(partsMode === "expanded")
  }, [partsMode, msg])

  const preview = messagePreview(msg)
  const isToolResult = msg.role === "tool"

  return (
    <div className="trace-history-msg min-w-0">
      <button
        type="button"
        className="flex items-baseline gap-2 w-full text-left min-w-0 py-1"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown size={14} className="text-text-muted shrink-0 mt-0.5" />
        ) : (
          <ChevronRight size={14} className="text-text-muted shrink-0 mt-0.5" />
        )}
        <span className="text-sm font-semibold text-text-secondary shrink-0">
          {historySpeaker(msg.role)}
        </span>
        {isToolResult && msg.toolCallId && (
          <span className="text-sm text-text-muted/50 font-mono shrink-0">
            {msg.toolCallId.slice(0, 10)}
          </span>
        )}
        {!open && (
          <span className="text-sm text-text-muted truncate min-w-0 flex-1">
            {preview}
          </span>
        )}
        {open && msg.content && (
          <span className="text-sm text-text-muted/40 shrink-0 ml-auto">
            {formatCharCount(msg.content.length)}
          </span>
        )}
      </button>

      {open && (
        <div className="pl-6 pb-2 min-w-0">
          {msg.content && <ExpandableText text={msg.content} />}
          {!msg.content && msg.toolCalls.length === 0 && (
            <span className="text-base text-text-muted/40 italic">null</span>
          )}
          {msg.toolCalls.length > 0 && (
            <div className="space-y-1.5 mt-1">
              {msg.toolCalls.map((tc) => (
                <div key={tc.id} className="trace-nested-tool">
                  <div className="text-base font-mono font-medium text-text">
                    {tc.name}
                  </div>
                  <JsonViewer
                    value={tc.arguments}
                    label="arguments"
                    defaultExpandDepth={1}
                    maxHeight={180}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Tool schema (context) ────────────────────────────────────────

function ToolDefinition({
  tool,
}: {
  tool: { name: string; description: string; parameters?: Record<string, unknown> }
}) {
  const [showSchema, setShowSchema] = useState(false)

  return (
    <div className="border border-border/30 rounded px-2.5 py-2">
      <div className="flex items-start gap-2 min-w-0">
        <span className="text-base font-mono font-medium text-text shrink-0">
          {tool.name}
        </span>
        <div className="min-w-0 flex-1">
          <ExpandableText
            text={tool.description}
            className="text-sm text-text-muted whitespace-pre-wrap break-words leading-relaxed font-sans"
            previewChars={160}
          />
        </div>
      </div>
      {tool.parameters && (
        <>
          <button
            type="button"
            className="trace-expand-toggle mt-1"
            onClick={() => setShowSchema((v) => !v)}
            aria-expanded={showSchema}
          >
            {showSchema ? "Hide schema" : "Show parameter schema"}
          </button>
          {showSchema && (
            <JsonViewer
              value={tool.parameters}
              label="schema"
              defaultExpandDepth={2}
              maxHeight={200}
            />
          )}
        </>
      )}
    </div>
  )
}

// ── One model round-trip ─────────────────────────────────────────

function LlmCallEntry({
  call,
  index,
  partsMode,
  open,
  onToggle,
  callId,
  rootRef,
}: {
  call: LlmCall
  index: number
  partsMode: PartsMode
  open: boolean
  onToggle: () => void
  callId: string
  rootRef: (el: HTMLDivElement | null) => void
}) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const req = call.request
  const res = call.response
  const usage = res?.usage ?? null
  const tokenLine = tokensInOut(usage)
  const headline = replyHeadline(res)

  return (
    <div
      id={callId}
      ref={rootRef}
      className="debug-trace-block shrink-0 rounded-lg border border-border/40 overflow-clip scroll-mt-14"
    >
      {/* Sticky-friendly call chrome */}
      <button
        type="button"
        className="trace-call-header flex items-start gap-3 px-3 py-3 w-full text-left hover:bg-elevated/35 transition-colors"
        onClick={onToggle}
      >
        {open ? (
          <ChevronDown size={16} className="text-text-muted shrink-0 mt-0.5" />
        ) : (
          <ChevronRight size={16} className="text-text-muted shrink-0 mt-0.5" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-base font-semibold text-text">
              Call {index + 1}
            </span>
            <span className="text-sm text-text-muted">
              Iteration {req.iteration + 1}
            </span>
            {res && (
              <span className="text-sm text-text-muted">{formatMs(res.durationMs)}</span>
            )}
          </div>
          <div className="text-base text-text-secondary mt-0.5 truncate">
            {headline}
          </div>
          {tokenLine && (
            <div className="text-sm text-text-muted mt-0.5 font-mono">{tokenLine}</div>
          )}
        </div>
      </button>

      {open && (
        <div className="border-t border-border/25">
          {/* History — secondary */}
          <div className="px-3 py-2 border-b border-border/20">
            <button
              type="button"
              className="flex items-center gap-2 w-full text-left py-1"
              onClick={() => setHistoryOpen((v) => !v)}
              aria-expanded={historyOpen}
            >
              {historyOpen ? (
                <ChevronDown size={14} className="text-text-muted shrink-0" />
              ) : (
                <ChevronRight size={14} className="text-text-muted shrink-0" />
              )}
              <span className="text-sm font-medium text-text-muted">
                Sent to model
              </span>
              <span className="text-sm text-text-muted/50">
                {req.messageCount} message{req.messageCount === 1 ? "" : "s"}
                {req.toolCount > 0 ? ` · ${req.toolCount} tools in schema` : ""}
              </span>
            </button>
            {historyOpen && (
              <div className="mt-1 space-y-0.5">
                {req.messages.length === 0 ? (
                  <span className="text-base text-text-muted/40 italic pl-6">
                    No messages recorded
                  </span>
                ) : (
                  req.messages.map((msg, mi) => (
                    <HistoryMessage
                      key={`${req.iteration}-${mi}`}
                      msg={msg}
                      partsMode={partsMode}
                    />
                  ))
                )}
              </div>
            )}
          </div>

          {/* Agent reply — primary, always visible when call is open */}
          <div className="trace-agent-reply px-3 py-3">
            <div className="flex items-baseline gap-2 flex-wrap mb-2">
              <span className="text-base font-semibold text-text">Agent replied</span>
              {res && (
                <span className="text-sm text-text-muted">{formatMs(res.durationMs)}</span>
              )}
              {tokenLine && (
                <span className="text-sm text-text-muted font-mono ml-auto">
                  {tokenLine}
                </span>
              )}
            </div>

            {!res && (
              <p className="trace-chat-body text-text-muted italic">Waiting for reply…</p>
            )}

            {res && res.content && (
              <div className="mb-3">
                <ExpandableText
                  text={res.content}
                  className="trace-chat-body whitespace-pre-wrap break-words"
                  maxExpandedHeight={480}
                />
              </div>
            )}

            {res && res.toolCalls.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-medium text-text-muted">
                  Called {res.toolCalls.length} tool
                  {res.toolCalls.length === 1 ? "" : "s"}
                </div>
                {res.toolCalls.map((tc) => (
                  <div key={tc.id} className="trace-nested-tool">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-base font-mono font-medium text-text">
                        {tc.name}
                      </span>
                      <span className="text-sm text-text-muted/40 font-mono">
                        {tc.id.slice(0, 14)}
                      </span>
                    </div>
                    <JsonViewer
                      value={tc.arguments}
                      label="arguments"
                      defaultExpandDepth={1}
                      maxHeight={220}
                    />
                  </div>
                ))}
              </div>
            )}

            {res && res.toolCalls.length === 0 && !res.content && (
              <p className="trace-chat-body text-error/70 italic">
                Empty reply — no text and no tool calls
              </p>
            )}

            {res && res.toolCalls.length === 0 && res.content && (
              <p className="text-sm text-text-muted mt-2">Final answer for this call</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main widget ──────────────────────────────────────────────────

export function DebugInspector() {
  const trace = useStore((s) => s.trace)
  const activeRunId = useStore((s) => s.activeRunId)
  const [filter, setFilter] = useState<FilterKind>("calls")
  const [partsMode, setPartsMode] = useState<PartsMode>("collapsed")
  const [search, setSearch] = useState("")
  const [openCalls, setOpenCalls] = useState<Set<number>>(() => new Set())
  const [activeNav, setActiveNav] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const callElsRef = useRef<Map<number, HTMLDivElement>>(new Map())
  const seededOpenRef = useRef(false)

  const systemPrompt = useMemo(
    () => trace.find((e): e is SystemPrompt => e.kind === "system-prompt"),
    [trace],
  )
  const toolsResolved = useMemo(
    () => trace.find((e): e is ToolsResolved => e.kind === "tools-resolved"),
    [trace],
  )
  const llmCalls = useMemo(() => pairLlmCalls(trace), [trace])
  const sqlQualityEntries = useMemo(
    () => trace.filter((e): e is SqlQuality => e.kind === "planner-sql-quality"),
    [trace],
  )

  // Open the latest call by default once we have data.
  useEffect(() => {
    if (seededOpenRef.current || llmCalls.length === 0) return
    seededOpenRef.current = true
    setOpenCalls(new Set([llmCalls.length - 1]))
    setActiveNav(llmCalls.length - 1)
  }, [llmCalls.length])

  useEffect(() => {
    seededOpenRef.current = false
  }, [activeRunId])

  // Follow new entries only when near the bottom.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distance < 80) el.scrollTop = el.scrollHeight
  }, [trace.length])

  // Track which call is in view for sticky nav highlight.
  useEffect(() => {
    const root = scrollRef.current
    if (!root || llmCalls.length === 0) return
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)
        const top = visible[0]
        if (!top?.target.id) return
        const match = /^trace-call-(\d+)$/.exec(top.target.id)
        if (!match) return
        setActiveNav(Number(match[1]))
      },
      { root, rootMargin: "-10% 0px -55% 0px", threshold: [0.1, 0.35, 0.6] },
    )
    for (const el of callElsRef.current.values()) observer.observe(el)
    return () => observer.disconnect()
  }, [llmCalls.length, filter])

  const stats = useMemo(() => {
    let promptTokens = 0
    let completionTokens = 0
    let totalTokens = 0
    let totalDuration = 0
    let answered = 0
    for (const c of llmCalls) {
      if (!c.response) continue
      answered += 1
      totalDuration += c.response.durationMs
      const u = c.response.usage
      if (u) {
        promptTokens += u.promptTokens
        completionTokens += u.completionTokens
        totalTokens += u.totalTokens
      }
    }
    return {
      toolCount: toolsResolved?.tools.length ?? 0,
      callCount: llmCalls.length,
      promptTokens,
      completionTokens,
      totalTokens,
      totalDuration,
      avgDuration: answered > 0 ? Math.round(totalDuration / answered) : 0,
    }
  }, [toolsResolved, llmCalls])

  const matchesSearch = useCallback(
    (text: string) => {
      if (!search) return true
      return text.toLowerCase().includes(search.toLowerCase())
    },
    [search],
  )

  const hasDebugData =
    Boolean(systemPrompt) ||
    Boolean(toolsResolved) ||
    llmCalls.length > 0 ||
    sqlQualityEntries.length > 0

  const showCalls = filter === "calls" || filter === "all"
  const showContext = filter === "context" || filter === "all"

  function toggleCall(index: number) {
    setOpenCalls((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  function jumpToCall(index: number) {
    setOpenCalls((prev) => new Set(prev).add(index))
    setActiveNav(index)
    setFilter((f) => (f === "context" ? "calls" : f))
    requestAnimationFrame(() => {
      callElsRef.current.get(index)?.scrollIntoView({
        block: "start",
        behavior: "smooth",
      })
    })
  }

  function bindCallEl(index: number, el: HTMLDivElement | null) {
    if (el) callElsRef.current.set(index, el)
    else callElsRef.current.delete(index)
  }

  const summaryLine = useMemo(() => {
    if (stats.callCount === 0) return "No model calls yet"
    const parts = [
      `${stats.callCount} call${stats.callCount === 1 ? "" : "s"}`,
      stats.totalDuration > 0 ? formatMs(stats.totalDuration) : null,
      stats.avgDuration > 0 ? `${formatMs(stats.avgDuration)} avg` : null,
    ].filter(Boolean)
    return parts.join(" · ")
  }, [stats])

  const tokenLine = useMemo(() => {
    if (stats.totalTokens <= 0) return null
    return `${fmtTokens(stats.promptTokens)} in · ${fmtTokens(stats.completionTokens)} out · ${fmtTokens(stats.totalTokens)} total`
  }, [stats])

  return (
    <div className="trace-widget flex flex-col h-full gap-2">
      {/* Readable summary — prose, not cryptic chips */}
      <div className="shrink-0 px-0.5 space-y-0.5">
        <div className="text-base text-text font-medium">{summaryLine}</div>
        {tokenLine && (
          <div className="text-sm text-text-muted font-mono">{tokenLine}</div>
        )}
        {stats.toolCount > 0 && (
          <div className="text-sm text-text-muted">
            {stats.toolCount} tool{stats.toolCount === 1 ? "" : "s"} available to the agent
          </div>
        )}
      </div>

      {/* Filters · parts · search */}
      <div className="flex items-center gap-2 shrink-0 flex-wrap">
        <div className="flex items-center gap-1 bg-elevated/30 rounded-lg p-0.5">
          {(
            [
              ["calls", "Calls"],
              ["context", "Context"],
              ["all", "All"],
            ] as [FilterKind, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`px-2.5 py-1.5 text-sm font-medium rounded-md transition-colors ${
                filter === key ? "bg-accent/20 text-accent" : "text-text-muted hover:text-text"
              }`}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>

        <div
          className="flex items-center gap-1 bg-elevated/30 rounded-lg p-0.5"
          title="Collapse or expand messages sent to the model"
        >
          <span className="px-1.5 text-xs text-text-muted/50 uppercase tracking-wide">
            History
          </span>
          {(
            [
              ["collapsed", "Collapsed"],
              ["expanded", "Expanded"],
            ] as [PartsMode, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`px-2 py-1.5 text-sm font-medium rounded-md transition-colors ${
                partsMode === key
                  ? "bg-elevated text-text"
                  : "text-text-muted hover:text-text"
              }`}
              onClick={() => setPartsMode(key)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5 flex-1 min-w-[8rem] ml-auto bg-elevated/30 rounded-lg px-2 py-1.5">
          <Search size={14} className="text-text-muted/50 shrink-0" />
          <input
            type="text"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-transparent text-sm text-text w-full outline-none placeholder:text-text-muted/30"
          />
        </div>
      </div>

      {/* Sticky jump rail — always reachable while scrolling */}
      {showCalls && llmCalls.length > 1 && (
        <div className="trace-call-nav shrink-0">
          <div className="trace-call-nav__inner">
            {llmCalls.map((call, i) => {
              const res = call.response
              const label = `Call ${i + 1}`
              const sub = res
                ? res.toolCalls.length > 0
                  ? res.toolCalls[0]!.name
                  : "answer"
                : "…"
              return (
                <button
                  key={`nav-${call.request.iteration}-${i}`}
                  type="button"
                  className={
                    activeNav === i
                      ? "trace-call-nav__btn trace-call-nav__btn--active"
                      : "trace-call-nav__btn"
                  }
                  onClick={() => jumpToCall(i)}
                  title={`Iteration ${call.request.iteration + 1}${res ? ` · ${formatMs(res.durationMs)}` : ""}`}
                >
                  <span className="trace-call-nav__label">{label}</span>
                  <span className="trace-call-nav__sub">{sub}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto space-y-3 pr-1">
        {!activeRunId && (
          <EmptyState
            icon={WIDGET_ICONS["debug-inspector"]}
            message="Select a run to inspect"
          />
        )}

        {activeRunId && !hasDebugData && (
          <EmptyState
            icon={WIDGET_ICONS["debug-inspector"]}
            message={
              trace.length === 0
                ? "No trace data yet — start an agent run"
                : "No debug entries found — run may predate debug instrumentation"
            }
          />
        )}

        {showContext && systemPrompt && matchesSearch(systemPrompt.text) && (
          <Section
            label="System prompt"
            badge={`${formatCharCount(systemPrompt.text.length)} chars`}
            copyable={systemPrompt.text}
          >
            <ExpandableText
              text={systemPrompt.text}
              className="code-pre"
              previewChars={500}
              maxExpandedHeight={500}
            />
          </Section>
        )}

        {showContext && toolsResolved && (
          <Section label="Tools available" badge={`${toolsResolved.tools.length}`}>
            <div className="space-y-1.5">
              {toolsResolved.tools
                .filter((t) => matchesSearch(`${t.name} ${t.description}`))
                .map((t) => (
                  <ToolDefinition key={t.name} tool={t} />
                ))}
            </div>
          </Section>
        )}

        {showContext && sqlQualityEntries.length > 0 && (
          <Section label="SQL quality" badge={`${sqlQualityEntries.length}`}>
            <div className="space-y-1.5">
              {sqlQualityEntries
                .filter((entry) => matchesSearch(JSON.stringify(entry)))
                .map((entry, index) => {
                  const notes: string[] = []
                  if (entry.validationCode) notes.push(`blocked=${entry.validationCode}`)
                  if (entry.missingPersistedMirrorCandidates.length > 0) {
                    notes.push(
                      `mirror=${entry.missingPersistedMirrorCandidates.join(",")}`,
                    )
                  }
                  return (
                    <div
                      key={`${entry.toolCallId}-${index}`}
                      className="border border-border/30 rounded px-2.5 py-2"
                    >
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="text-base font-medium text-text">
                          {entry.phase}
                        </span>
                        <span className="text-base font-mono text-text-secondary">
                          {entry.toolName}
                        </span>
                        <span className="text-sm text-text-muted">
                          Iteration {entry.iteration + 1}
                        </span>
                        {entry.durationMs != null && (
                          <span className="text-sm text-text-muted ml-auto">
                            {formatMs(entry.durationMs)}
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-text-muted mt-1">
                        {notes.join(" · ") || "ok"}
                      </div>
                      {entry.sqlPreview && (
                        <div className="mt-1">
                          <ExpandableText
                            text={entry.sqlPreview}
                            className="code-pre"
                            previewChars={240}
                            maxExpandedHeight={320}
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
            </div>
          </Section>
        )}

        {showCalls &&
          llmCalls.map((call, i) => {
            if (search) {
              const blob = JSON.stringify(call.request) + JSON.stringify(call.response)
              if (!blob.toLowerCase().includes(search.toLowerCase())) return null
            }
            return (
              <LlmCallEntry
                key={`llm-${call.request.iteration}-${i}`}
                call={call}
                index={i}
                partsMode={partsMode}
                open={openCalls.has(i)}
                onToggle={() => toggleCall(i)}
                callId={`trace-call-${i}`}
                rootRef={(el) => bindCallEl(i, el)}
              />
            )
          })}
      </div>
    </div>
  )
}
