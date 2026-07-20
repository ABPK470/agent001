/**
 * Trace (DebugInspector) — why the agent did that.
 *
 * Primary object: the LLM call timeline (iteration · tokens · time · outcome).
 * Context (system prompt, tools, SQL quality) is secondary and collapsed by default.
 * Message parts (system / user / agent / tool) can be fully collapsed or expanded.
 */

import { ChevronDown, ChevronRight, Clock, Copy, Search } from "lucide-react"
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

// ── Role / meta helpers ──────────────────────────────────────────

/** Wire role → product label (never “assistant”). */
function roleLabel(role: string): string {
  if (role === "assistant") return "Agent"
  if (role === "system") return "System"
  if (role === "user") return "User"
  if (role === "tool") return "Tool"
  return role
}

function roleTone(role: string): string {
  if (role === "system") return "text-accent"
  if (role === "user") return "text-success"
  if (role === "assistant") return "text-warning"
  if (role === "tool") return "text-info"
  return "text-text-muted"
}

function roleBorder(role: string): string {
  if (role === "system") return "var(--color-accent)"
  if (role === "user") return "var(--color-success)"
  if (role === "assistant") return "var(--color-warning)"
  if (role === "tool") return "var(--color-info)"
  return "var(--color-border)"
}

function formatCharCount(n: number): string {
  return n.toLocaleString()
}

function copyText(text: string) {
  navigator.clipboard.writeText(text)
}

function durationTone(ms: number): string {
  if (ms > 5000) return "text-error"
  if (ms > 2000) return "text-warning"
  return "text-success"
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

function callOutcome(res: LlmResponse | null): string {
  if (!res) return "pending"
  if (res.toolCalls.length > 0) {
    const names = res.toolCalls.map((t) => t.name)
    const shown = names.slice(0, 3).join(", ")
    const more = names.length > 3 ? ` +${names.length - 3}` : ""
    return `${res.toolCalls.length} tool${res.toolCalls.length === 1 ? "" : "s"} · ${shown}${more}`
  }
  if (res.content) return "final answer"
  return "empty"
}

function messagePreview(msg: TraceMessage): string {
  if (msg.toolCalls.length > 0) {
    return msg.toolCalls.map((t) => t.name).join(", ")
  }
  if (msg.content) {
    const line = msg.content.replace(/\s+/g, " ").trim()
    return line.length > 96 ? `${line.slice(0, 95)}…` : line
  }
  if (msg.toolCallId) return `← ${msg.toolCallId.slice(0, 12)}`
  return "empty"
}

// ── Expandable text ──────────────────────────────────────────────

const TEXT_PREVIEW_CHARS = 300

function ExpandableText({
  text,
  className = "text-sm font-mono text-text-secondary whitespace-pre-wrap break-words leading-relaxed",
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

// ── Collapsible section ──────────────────────────────────────────

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
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="debug-trace-block shrink-0 rounded-lg border border-border/50 overflow-clip">
      <button
        type="button"
        className="flex items-center gap-2 w-full px-3 py-2 text-left bg-elevated/30 hover:bg-elevated/50 transition-colors"
        onClick={() => setOpen(!open)}
      >
        {open ? (
          <ChevronDown size={14} className="text-text-muted shrink-0" />
        ) : (
          <ChevronRight size={14} className="text-text-muted shrink-0" />
        )}
        <span className="text-sm font-medium text-text">{label}</span>
        {badge && (
          <span className={`text-sm font-mono ml-auto ${badgeColor}`}>{badge}</span>
        )}
      </button>
      {open && (
        <div className="px-3 py-2 border-t border-border/30 relative">
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

// ── Message part (system / user / agent / tool) ──────────────────

function MessagePart({
  msg,
  index,
  partsMode,
}: {
  msg: TraceMessage
  index: number
  partsMode: PartsMode
}) {
  const [open, setOpen] = useState(partsMode === "expanded")

  useEffect(() => {
    setOpen(partsMode === "expanded")
  }, [partsMode, msg])

  const preview = messagePreview(msg)

  return (
    <div
      className="border-l-2 pl-2 py-1 min-w-0"
      style={{ borderColor: roleBorder(msg.role) }}
    >
      <button
        type="button"
        className="flex items-center gap-2 w-full text-left min-w-0 group"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown size={12} className="text-text-muted shrink-0" />
        ) : (
          <ChevronRight size={12} className="text-text-muted shrink-0" />
        )}
        <span className={`text-sm font-mono font-bold ${roleTone(msg.role)}`}>
          {roleLabel(msg.role)}
        </span>
        <span className="text-xs text-text-muted/40">#{index + 1}</span>
        {msg.toolCallId && (
          <span className="text-xs text-text-muted/40 font-mono shrink-0">
            ← {msg.toolCallId.slice(0, 12)}
          </span>
        )}
        {msg.content && (
          <span className="text-xs text-text-muted/35 shrink-0">
            {formatCharCount(msg.content.length)}
          </span>
        )}
        {!open && (
          <span className="text-xs text-text-muted/50 truncate min-w-0 flex-1 font-mono">
            {preview}
          </span>
        )}
      </button>

      {open && (
        <div className="mt-1 pl-4 min-w-0">
          {msg.content && <ExpandableText text={msg.content} />}

          {!msg.content && msg.toolCalls.length === 0 && (
            <span className="text-sm text-text-muted/35 italic">null</span>
          )}

          {msg.toolCalls.length > 0 && (
            <div className="space-y-1">
              {msg.toolCalls.map((tc) => (
                <div
                  key={tc.id}
                  className="bg-warning/5 border border-warning/10 rounded px-2 py-1"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono font-semibold text-warning">
                      {tc.name}
                    </span>
                    <span className="text-xs text-text-muted/30 font-mono">
                      {tc.id.slice(0, 12)}
                    </span>
                  </div>
                  <JsonViewer
                    value={tc.arguments}
                    label="arguments"
                    defaultExpandDepth={2}
                    maxHeight={200}
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

// ── Tool definition ──────────────────────────────────────────────

function ToolDefinition({
  tool,
}: {
  tool: { name: string; description: string; parameters?: Record<string, unknown> }
}) {
  const [showSchema, setShowSchema] = useState(false)

  return (
    <div className="border border-border/30 rounded px-2 py-1.5">
      <div className="flex items-start gap-2 min-w-0">
        <span className="text-sm font-mono font-semibold text-warning shrink-0">
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

// ── LLM call card ────────────────────────────────────────────────

function LlmCallEntry({
  call,
  index,
  partsMode,
}: {
  call: LlmCall
  index: number
  partsMode: PartsMode
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const req = call.request
  const res = call.response
  const usage = res?.usage ?? null
  const outcome = callOutcome(res)

  function toggleOpen() {
    const next = !open
    setOpen(next)
    if (next) {
      requestAnimationFrame(() => {
        rootRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
      })
    }
  }

  return (
    <div
      ref={rootRef}
      className="debug-trace-block shrink-0 rounded-lg border border-border/40 overflow-clip"
    >
      <button
        type="button"
        className="flex items-center gap-2.5 px-3 py-2 bg-elevated/20 w-full text-left cursor-pointer hover:bg-elevated/40 transition-colors flex-wrap"
        onClick={toggleOpen}
      >
        {open ? (
          <ChevronDown size={14} className="text-text-muted shrink-0" />
        ) : (
          <ChevronRight size={14} className="text-text-muted shrink-0" />
        )}
        <span className="text-sm font-semibold text-info shrink-0">
          LLM #{index + 1}
        </span>
        <span className="text-sm font-mono text-text-muted shrink-0">
          iter {req.iteration + 1}
        </span>
        <span className="text-sm font-mono text-text-secondary truncate min-w-0">
          {outcome}
        </span>
        <span className="flex items-center gap-2 ml-auto shrink-0 text-sm font-mono">
          {usage ? (
            <span className="text-text-muted" title="prompt → completion (total)">
              {fmtTokens(usage.promptTokens)}→{fmtTokens(usage.completionTokens)}
              <span className="text-text-muted/50"> · {fmtTokens(usage.totalTokens)}</span>
            </span>
          ) : (
            <span className="text-text-muted/40">— tok</span>
          )}
          {res ? (
            <span className={durationTone(res.durationMs)}>{formatMs(res.durationMs)}</span>
          ) : (
            <span className="text-text-muted/40">…</span>
          )}
        </span>
      </button>

      {open && (
        <>
          <div className="px-3 py-2 border-t border-border/20">
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <span className="text-xs font-medium text-text-muted/55 uppercase tracking-wider">
                Request
              </span>
              <span className="text-xs font-mono text-text-muted/45">
                {req.messageCount} part{req.messageCount === 1 ? "" : "s"} · {req.toolCount}{" "}
                tool def{req.toolCount === 1 ? "" : "s"}
              </span>
            </div>
            {req.messages.length === 0 ? (
              <span className="text-sm text-text-muted/40 italic">No messages recorded</span>
            ) : (
              <div className="space-y-1">
                {req.messages.map((msg, mi) => (
                  <MessagePart
                    key={`${req.iteration}-${mi}`}
                    msg={msg}
                    index={mi}
                    partsMode={partsMode}
                  />
                ))}
              </div>
            )}
          </div>

          {res && (
            <div className="px-3 py-2 border-t border-border/20 bg-elevated/10">
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                <span className="text-xs font-medium text-text-muted/55 uppercase tracking-wider">
                  Response
                </span>
                {usage && (
                  <span className="text-xs font-mono text-text-muted/50">
                    {fmtTokens(usage.promptTokens)} prompt ·{" "}
                    {fmtTokens(usage.completionTokens)} completion ·{" "}
                    {fmtTokens(usage.totalTokens)} total
                  </span>
                )}
                <span className={`text-xs font-mono ${durationTone(res.durationMs)}`}>
                  {formatMs(res.durationMs)}
                </span>
              </div>

              {res.content && (
                <div className="mb-2">
                  <div className="text-xs text-text-muted/40 mb-0.5">content</div>
                  <ExpandableText
                    text={res.content}
                    className="code-pre"
                    maxExpandedHeight={360}
                  />
                </div>
              )}

              {res.toolCalls.length > 0 && (
                <div>
                  <div className="text-xs text-text-muted/40 mb-0.5">tool calls</div>
                  <div className="space-y-1">
                    {res.toolCalls.map((tc) => (
                      <div
                        key={tc.id}
                        className="bg-warning/5 border border-warning/10 rounded px-2 py-1"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-mono font-semibold text-warning">
                            {tc.name}
                          </span>
                          <span className="text-xs text-text-muted/30 font-mono">
                            {tc.id}
                          </span>
                        </div>
                        <JsonViewer
                          value={tc.arguments}
                          label="arguments"
                          defaultExpandDepth={2}
                          maxHeight={200}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {res.toolCalls.length === 0 && !res.content && (
                <div className="text-sm text-error/50 italic">
                  Empty response — no content and no tool calls
                </div>
              )}

              {res.toolCalls.length === 0 && res.content && (
                <div className="text-sm text-success/60 mt-1">
                  ↳ No tool calls — this became the final answer
                </div>
              )}
            </div>
          )}
        </>
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
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distance < 80) el.scrollTop = el.scrollHeight
  }, [trace.length])

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

  const stats = useMemo(() => {
    let promptTokens = 0
    let completionTokens = 0
    let totalTokens = 0
    let totalDuration = 0
    let answered = 0
    let minIter: number | null = null
    let maxIter: number | null = null
    for (const c of llmCalls) {
      const iter = c.request.iteration + 1
      minIter = minIter == null ? iter : Math.min(minIter, iter)
      maxIter = maxIter == null ? iter : Math.max(maxIter, iter)
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
      minIter,
      maxIter,
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

  const iterLabel =
    stats.minIter != null && stats.maxIter != null
      ? stats.minIter === stats.maxIter
        ? `iter ${stats.minIter}`
        : `iter ${stats.minIter}–${stats.maxIter}`
      : null

  return (
    <div className="flex flex-col h-full gap-2">
      {/* Glanceable run meta */}
      <div className="flex items-center gap-2 shrink-0 flex-wrap">
        <MetaChip
          label="llm"
          value={
            stats.callCount > 0
              ? `${stats.callCount} · ${formatMs(stats.avgDuration)} avg`
              : "—"
          }
          accent="text-info"
        />
        <MetaChip
          label="tokens"
          value={
            stats.totalTokens > 0
              ? `${fmtTokens(stats.promptTokens)}→${fmtTokens(stats.completionTokens)} · ${fmtTokens(stats.totalTokens)}`
              : "—"
          }
          accent="text-warning"
        />
        <MetaChip
          label="time"
          value={stats.totalDuration > 0 ? formatMs(stats.totalDuration) : "—"}
          accent="text-text-muted"
          icon={<Clock size={12} />}
        />
        {iterLabel && <MetaChip label="loop" value={iterLabel} accent="text-accent" />}
        {stats.toolCount > 0 && (
          <MetaChip label="tools" value={String(stats.toolCount)} accent="text-warning" />
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
              className={`px-2.5 py-1 text-sm font-medium rounded-md transition-colors ${
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
          title="Collapse or expand system / user / agent / tool parts inside each LLM call"
        >
          <span className="px-1.5 text-xs text-text-muted/50 uppercase tracking-wide">
            Parts
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
              className={`px-2 py-1 text-sm font-medium rounded-md transition-colors ${
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

        <div className="flex items-center gap-1.5 flex-1 min-w-[8rem] ml-auto bg-elevated/30 rounded-lg px-2 py-1">
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

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto space-y-2 pr-1">
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

        {/* Context — secondary, collapsed by default */}
        {showContext && systemPrompt && matchesSearch(systemPrompt.text) && (
          <Section
            label="System prompt"
            badge={`${formatCharCount(systemPrompt.text.length)} chars`}
            badgeColor="text-accent/70"
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
          <Section
            label="Tools available"
            badge={`${toolsResolved.tools.length}`}
            badgeColor="text-warning/70"
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

        {showContext && sqlQualityEntries.length > 0 && (
          <Section
            label="SQL quality"
            badge={`${sqlQualityEntries.length}`}
            badgeColor="text-warning/70"
          >
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
                  const overusedRefs = entry.largeObjectRefs.filter((ref) => ref.count > 2)
                  if (overusedRefs.length > 0) {
                    notes.push(
                      overusedRefs.map((ref) => `${ref.name}×${ref.count}`).join(", "),
                    )
                  }
                  if (entry.tempScalarSubqueryCount > 0) {
                    notes.push(`temp-subq=${entry.tempScalarSubqueryCount}`)
                  }
                  return (
                    <div
                      key={`${entry.toolCallId}-${index}`}
                      className="border border-border/30 rounded px-2 py-1.5"
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className={`text-sm font-mono font-semibold ${
                            entry.phase === "blocked"
                              ? "text-error"
                              : entry.validationOk
                                ? "text-success"
                                : "text-warning"
                          }`}
                        >
                          {entry.phase}
                        </span>
                        <span className="text-sm font-mono text-text-muted">
                          {entry.toolName}
                        </span>
                        <span className="text-xs text-text-muted/40">
                          iter {entry.iteration + 1}
                        </span>
                        {entry.durationMs != null && (
                          <span className="text-xs font-mono text-text-muted/40 ml-auto">
                            {formatMs(entry.durationMs)}
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-text-secondary mt-1">
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

        {/* Primary: LLM call timeline */}
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
              />
            )
          })}
      </div>
    </div>
  )
}

function MetaChip({
  label,
  value,
  accent,
  icon,
}: {
  label: string
  value: string
  accent: string
  icon?: ReactNode
}) {
  return (
    <div className="flex items-center gap-1.5 text-sm font-mono text-text-muted bg-elevated/50 px-2 py-1 rounded">
      {icon}
      <span className={accent}>{label}</span>
      <span className="text-text-secondary">{value}</span>
    </div>
  )
}
