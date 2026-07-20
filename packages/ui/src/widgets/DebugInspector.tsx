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

import { Check, ChevronDown, ChevronRight, Copy, Search, X } from "lucide-react"
import {
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

/**
 * Label a history row. ask_user answers are tool-role messages in the LLM
 * protocol — show them as “User answer”, not a generic tool result.
 */
function historyRowLabel(
  msg: TraceMessage,
  messages: TraceMessage[],
  index: number,
): { speaker: string; detail?: string } {
  if (msg.role !== "tool") return { speaker: historySpeaker(msg.role) }
  for (let i = index - 1; i >= 0; i--) {
    const prev = messages[i]!
    if (prev.role !== "assistant") continue
    const tc = prev.toolCalls.find((t) => t.id === msg.toolCallId)
    if (!tc) continue
    if (tc.name === "ask_user") {
      return { speaker: "User answer", detail: "via ask_user" }
    }
    return { speaker: "Tool result", detail: tc.name }
  }
  return { speaker: "Tool result" }
}

/** Fixed header height used for stacked sticky offsets. */
const TRACE_CALL_HEADER_H_PX = 34

function formatCharCount(n: number): string {
  return n.toLocaleString()
}

/** Shared Copy / Copied control — same feedback as chat markdown tables. */
function useCopyFeedback() {
  const [copied, setCopied] = useState(false)
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
    }
  }, [])

  function copyValue(value: string, e?: { stopPropagation: () => void }) {
    e?.stopPropagation()
    void navigator.clipboard.writeText(value).then(() => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
      setCopied(true)
      clearTimerRef.current = setTimeout(() => {
        setCopied(false)
        clearTimerRef.current = null
      }, 1600)
    }).catch(() => { /* ignore */ })
  }

  return { copied, copyValue }
}

function CopyControl({
  value,
  ariaLabel,
  className = "trace-id-chip__copy",
}: {
  value: string
  ariaLabel: string
  className?: string
}) {
  const { copied, copyValue } = useCopyFeedback()
  return (
    <button
      type="button"
      className={className}
      onClick={(e) => copyValue(value, e)}
      aria-label={copied ? "Copied" : ariaLabel}
    >
      {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  )
}

/**
 * Correlator row — full id always visible + Copy control matching chat
 * markdown tables (icon + “Copy” / check + “Copied”).
 */
function IdChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="trace-id-chip">
      <span className="trace-id-chip__label">{label}</span>
      <span className="trace-id-chip__value font-mono">{value}</span>
      <CopyControl value={value} ariaLabel={`Copy ${label}`} />
    </span>
  )
}

function SectionCopyButton({ text }: { text: string }) {
  return (
    <div className="absolute top-2 right-2">
      <CopyControl
        value={text}
        ariaLabel="Copy"
        className="trace-id-chip__copy"
      />
    </div>
  )
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

/**
 * One-line outcome for a call header. Only these forms appear:
 *   Waiting… | Called <tools> | Final answer | Empty reply
 * Tool names are the signal when the agent called tools; any accompanying
 * message text is in the expanded “Agent replied” body — not hinted here.
 */
function replyHeadline(res: LlmResponse | null): string {
  if (!res) return "Waiting…"
  if (res.toolCalls.length > 0) {
    const names = res.toolCalls.map((t) => t.name)
    if (names.length === 1) return names[0]!
    if (names.length === 2) return `${names[0]}, ${names[1]}`
    return `${names[0]}, ${names[1]} +${names.length - 2}`
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

/** Run-level in/out bar only — never beside “Agent replied”. */
function TokenSplit({
  promptTokens,
  completionTokens,
}: {
  promptTokens: number
  completionTokens: number
}) {
  const total = promptTokens + completionTokens
  if (total <= 0) return null
  const inPct = Math.max(2, Math.round((promptTokens / total) * 100))
  return (
    <div className="trace-token-split">
      <div
        className="trace-token-split__bar"
        role="img"
        aria-label={`Tokens: ${fmtTokens(promptTokens)} in, ${fmtTokens(completionTokens)} out`}
      >
        <span className="trace-token-split__in" style={{ width: `${inPct}%` }} />
        <span className="trace-token-split__out" style={{ width: `${100 - inPct}%` }} />
      </div>
      <div className="trace-token-split__labels">
        <span>
          <span className="trace-token-split__tag">In</span> {fmtTokens(promptTokens)}
        </span>
        <span>
          <span className="trace-token-split__tag">Out</span> {fmtTokens(completionTokens)}
        </span>
      </div>
    </div>
  )
}

/** Where a call matched the filter — shown so search feels intentional. */
interface CallSearchHit {
  reasons: string[]
  inHistory: boolean
  inReply: boolean
}

function searchCall(call: LlmCall, index: number, rawQuery: string): CallSearchHit | null {
  const q = rawQuery.trim().toLowerCase()
  if (!q) return null

  const reasons: string[] = []
  let inHistory = false
  let inReply = false
  const req = call.request
  const res = call.response
  const callNo = index + 1
  const iterNo = req.iteration + 1

  if (q === String(callNo) || q === `call ${callNo}` || q === `#${callNo}`) {
    reasons.push(`Call ${callNo}`)
  }
  if (q === `iteration ${iterNo}` || q === `iter ${iterNo}` || q === `i${iterNo}`) {
    reasons.push(`Iteration ${iterNo}`)
  } else if (q === String(iterNo) && !reasons.includes(`Call ${callNo}`)) {
    reasons.push(`Iteration ${iterNo}`)
  }

  if (res) {
    for (const tc of res.toolCalls) {
      if (tc.name.toLowerCase().includes(q)) {
        reasons.push(`tool ${tc.name}`)
        inReply = true
      }
      if (tc.id.toLowerCase().includes(q)) {
        reasons.push("tool call id")
        inReply = true
      }
      const args = JSON.stringify(tc.arguments).toLowerCase()
      if (args.includes(q) && !reasons.some((r) => r.startsWith("tool "))) {
        reasons.push(`tool args (${tc.name})`)
        inReply = true
      }
    }
    if (res.content?.toLowerCase().includes(q)) {
      reasons.push("agent reply")
      inReply = true
    }
    const headline = replyHeadline(res).toLowerCase()
    if (headline.includes(q) && !inReply) {
      reasons.push("outcome")
      inReply = true
    }
  }

  for (const msg of req.messages) {
    if (msg.content?.toLowerCase().includes(q)) {
      inHistory = true
      break
    }
    if (msg.role.toLowerCase().includes(q) || historySpeaker(msg.role).toLowerCase().includes(q)) {
      inHistory = true
      break
    }
    if (msg.toolCallId?.toLowerCase().includes(q)) {
      reasons.push("tool call id")
      inHistory = true
      break
    }
    for (const tc of msg.toolCalls) {
      if (tc.name.toLowerCase().includes(q) || tc.id.toLowerCase().includes(q)) {
        if (tc.id.toLowerCase().includes(q)) reasons.push("tool call id")
        inHistory = true
        break
      }
    }
    if (inHistory) break
  }
  if (inHistory && !reasons.includes("history")) reasons.push("history")

  if (reasons.length === 0) return null
  return { reasons: reasons.slice(0, 3), inHistory, inReply }
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
            <SectionCopyButton text={copyable} />
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
  index,
  messages,
  partsMode,
}: {
  msg: TraceMessage
  index: number
  messages: TraceMessage[]
  partsMode: PartsMode
}) {
  const [open, setOpen] = useState(partsMode === "expanded")

  useEffect(() => {
    setOpen(partsMode === "expanded")
  }, [partsMode, msg])

  const preview = messagePreview(msg)
  const isToolResult = msg.role === "tool"
  const label = historyRowLabel(msg, messages, index)
  const isUserAnswer = label.speaker === "User answer"

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
        <span
          className={`text-sm font-semibold shrink-0 ${
            isUserAnswer ? "text-text" : "text-text-secondary"
          }`}
        >
          {label.speaker}
        </span>
        {label.detail && (
          <span className="text-sm text-text-muted/50 shrink-0">{label.detail}</span>
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
        <div className="pl-6 pb-2 min-w-0 space-y-1.5">
          {isToolResult && msg.toolCallId && (
            <IdChip label="tool call" value={msg.toolCallId} />
          )}
          {msg.content && <ExpandableText text={msg.content} />}
          {!msg.content && msg.toolCalls.length === 0 && (
            <span className="text-base text-text-muted/40 italic">null</span>
          )}
          {msg.toolCalls.length > 0 && (
            <div className="space-y-1.5 mt-1">
              {msg.toolCalls.map((tc) => (
                <div key={tc.id} className="trace-nested-tool">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-base font-mono font-medium text-text">
                      {tc.name}
                    </span>
                    <IdChip label="tool call" value={tc.id} />
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
  searchHit,
}: {
  call: LlmCall
  index: number
  partsMode: PartsMode
  open: boolean
  onToggle: () => void
  searchHit: CallSearchHit | null
}) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const req = call.request
  const res = call.response
  const usage = res?.usage ?? null
  const headline = replyHeadline(res)
  const askedUser = Boolean(res?.toolCalls.some((t) => t.name === "ask_user"))
  const stackStyle = {
    ["--trace-stack-top" as string]: `${index * TRACE_CALL_HEADER_H_PX}px`,
    ["--trace-stack-z" as string]: String(20 + index),
  }

  // When search hits history, open that section so the match is reachable.
  useEffect(() => {
    if (searchHit?.inHistory) setHistoryOpen(true)
  }, [searchHit])

  return (
    <div className={`trace-call${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="trace-call-header flex items-center gap-2 px-2.5 py-1.5 w-full text-left transition-colors"
        style={stackStyle}
        onClick={onToggle}
      >
        {open ? (
          <ChevronDown size={14} className="text-text-muted shrink-0" />
        ) : (
          <ChevronRight size={14} className="text-text-muted shrink-0" />
        )}
        <span className="text-sm font-semibold text-text shrink-0 tabular-nums">
          Call {index + 1}
        </span>
        <span className="text-sm text-text-muted shrink-0 tabular-nums">
          iter {req.iteration + 1}
        </span>
        <span className="text-sm text-text-secondary truncate min-w-0 flex-1">
          {headline}
          {searchHit && searchHit.reasons.length > 0 && (
            <span className="text-text-muted"> · matched {searchHit.reasons[0]}</span>
          )}
        </span>
        <span className="flex items-center gap-2 shrink-0 text-sm text-text-muted tabular-nums">
          {usage && (
            <span title="Tokens in / out">
              {fmtTokens(usage.promptTokens)}
              <span className="text-text-muted/40"> / </span>
              {fmtTokens(usage.completionTokens)}
            </span>
          )}
          {res && <span>{formatMs(res.durationMs)}</span>}
        </span>
      </button>

      {open && (
        <div className="trace-call-body">
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
                      index={mi}
                      messages={req.messages}
                      partsMode={partsMode}
                    />
                  ))
                )}
              </div>
            )}
          </div>

          {/* Agent reply — primary; tokens live on the call header only */}
          <div className="trace-agent-reply px-3 py-3">
            <div className="text-sm font-medium text-text-muted mb-2">Agent replied</div>

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
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="text-base font-mono font-medium text-text">
                        {tc.name}
                      </span>
                      <IdChip label="tool call" value={tc.id} />
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

            {askedUser && (
              <p className="text-sm text-text-muted mt-2">
                Waiting on the human — their answer appears on the{" "}
                <span className="text-text-secondary">next</span> call as{" "}
                <span className="text-text-secondary">User answer</span> (tool
                protocol), not as a User message on this call.
              </p>
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
  const activeThreadId = useStore((s) => {
    if (!s.activeRunId) return null
    return s.runs.find((r) => r.id === s.activeRunId)?.threadId ?? null
  })
  const [filter, setFilter] = useState<FilterKind>("calls")
  const [partsMode, setPartsMode] = useState<PartsMode>("collapsed")
  const [search, setSearch] = useState("")
  const [openCalls, setOpenCalls] = useState<Set<number>>(() => new Set())
  const scrollRef = useRef<HTMLDivElement>(null)
  const seededOpenRef = useRef(false)
  const searchOpenSeedRef = useRef("")

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

  const query = search.trim()
  const callHits = useMemo(() => {
    if (!query) return null
    const q = query.toLowerCase()
    const matchedRun = Boolean(activeRunId && activeRunId.toLowerCase().includes(q))
    const matchedThread = Boolean(activeThreadId && activeThreadId.toLowerCase().includes(q))
    const map = new Map<number, CallSearchHit>()
    llmCalls.forEach((call, i) => {
      if (matchedRun || matchedThread) {
        map.set(i, {
          reasons: [matchedRun ? "run id" : "thread id"],
          inHistory: false,
          inReply: false,
        })
        return
      }
      const hit = searchCall(call, i, query)
      if (hit) map.set(i, hit)
    })
    return map
  }, [llmCalls, query, activeRunId, activeThreadId])

  // Open the latest call by default once we have data.
  useEffect(() => {
    if (seededOpenRef.current || llmCalls.length === 0) return
    seededOpenRef.current = true
    setOpenCalls(new Set([llmCalls.length - 1]))
  }, [llmCalls.length])

  useEffect(() => {
    seededOpenRef.current = false
    searchOpenSeedRef.current = ""
  }, [activeRunId])

  // Searching opens matching calls so results are immediately readable.
  useEffect(() => {
    if (!query || !callHits) {
      searchOpenSeedRef.current = ""
      return
    }
    if (searchOpenSeedRef.current === query) return
    searchOpenSeedRef.current = query
    setOpenCalls(new Set(callHits.keys()))
  }, [query, callHits])

  // Follow new entries only when near the bottom.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distance < 80) el.scrollTop = el.scrollHeight
  }, [trace.length])

  const stats = useMemo(() => {
    let promptTokens = 0
    let completionTokens = 0
    let totalDuration = 0
    for (const c of llmCalls) {
      if (!c.response) continue
      totalDuration += c.response.durationMs
      const u = c.response.usage
      if (u) {
        promptTokens += u.promptTokens
        completionTokens += u.completionTokens
      }
    }
    return {
      callCount: llmCalls.length,
      promptTokens,
      completionTokens,
      totalDuration,
    }
  }, [llmCalls])

  const filteredTools = useMemo(() => {
    if (!toolsResolved) return []
    if (!query) return toolsResolved.tools
    const q = query.toLowerCase()
    return toolsResolved.tools.filter(
      (t) =>
        t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
    )
  }, [toolsResolved, query])

  const filteredSql = useMemo(() => {
    if (!query) return sqlQualityEntries
    const q = query.toLowerCase()
    return sqlQualityEntries.filter((entry) => {
      return (
        entry.toolName.toLowerCase().includes(q) ||
        entry.phase.toLowerCase().includes(q) ||
        entry.sqlPreview.toLowerCase().includes(q) ||
        (entry.validationCode?.toLowerCase().includes(q) ?? false)
      )
    })
  }, [sqlQualityEntries, query])

  const promptMatches =
    !query || (systemPrompt?.text.toLowerCase().includes(query.toLowerCase()) ?? false)

  const hasDebugData =
    Boolean(systemPrompt) ||
    Boolean(toolsResolved) ||
    llmCalls.length > 0 ||
    sqlQualityEntries.length > 0

  const showCalls = filter === "calls" || filter === "all"
  const showContext = filter === "context" || filter === "all"

  const visibleCallIndexes = useMemo(() => {
    if (!callHits) return llmCalls.map((_, i) => i)
    return [...callHits.keys()]
  }, [llmCalls, callHits])

  const searchStatus = useMemo(() => {
    if (!query) return null
    const callPart =
      showCalls && llmCalls.length > 0
        ? `${callHits?.size ?? 0} of ${llmCalls.length} calls`
        : null
    const contextBits: string[] = []
    if (showContext && systemPrompt && promptMatches) contextBits.push("prompt")
    if (showContext && filteredTools.length > 0) {
      contextBits.push(`${filteredTools.length} tool${filteredTools.length === 1 ? "" : "s"}`)
    }
    if (showContext && filteredSql.length > 0) {
      contextBits.push(`${filteredSql.length} sql`)
    }
    const parts = [callPart, contextBits.length > 0 ? contextBits.join(" · ") : null].filter(
      Boolean,
    )
    if (parts.length === 0) return "No matches"
    return parts.join(" · ")
  }, [
    query,
    showCalls,
    showContext,
    llmCalls.length,
    callHits,
    systemPrompt,
    promptMatches,
    filteredTools.length,
    filteredSql.length,
  ])

  function toggleCall(index: number) {
    setOpenCalls((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  return (
    <div className="trace-widget flex flex-col h-full gap-2">
      <div className="trace-summary shrink-0">
        <div className="trace-summary__meta">
          {stats.callCount === 0 ? (
            <span>No model calls yet</span>
          ) : (
            <>
              <span>
                {stats.callCount} call{stats.callCount === 1 ? "" : "s"}
              </span>
              {stats.totalDuration > 0 && (
                <>
                  <span className="trace-summary__dot" aria-hidden />
                  <span className="tabular-nums">{formatMs(stats.totalDuration)}</span>
                </>
              )}
            </>
          )}
        </div>
        {(activeRunId || activeThreadId) && (
          <div className="trace-summary__ids">
            {activeRunId && <IdChip label="run" value={activeRunId} />}
            {activeThreadId && <IdChip label="thread" value={activeThreadId} />}
          </div>
        )}
        {(stats.promptTokens > 0 || stats.completionTokens > 0) && (
          <TokenSplit
            promptTokens={stats.promptTokens}
            completionTokens={stats.completionTokens}
          />
        )}
      </div>

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

        <div className="flex items-center gap-1.5 flex-1 min-w-[10rem] ml-auto bg-elevated/30 rounded-lg px-2 py-1.5">
          <Search size={14} className="text-text-muted/50 shrink-0" />
          <input
            type="search"
            placeholder="Filter: run id, tool call id, tool name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-transparent text-sm text-text w-full outline-none placeholder:text-text-muted/35"
            aria-label="Filter trace"
          />
          {search && (
            <button
              type="button"
              className="p-0.5 rounded text-text-muted/50 hover:text-text-muted"
              onClick={() => setSearch("")}
              title="Clear filter"
              aria-label="Clear filter"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {searchStatus && (
        <div className="text-sm text-text-muted shrink-0 px-0.5">
          {searchStatus}
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

        {activeRunId &&
          hasDebugData &&
          query &&
          visibleCallIndexes.length === 0 &&
          !(showContext && (promptMatches || filteredTools.length > 0 || filteredSql.length > 0)) && (
            <EmptyState
              icon={WIDGET_ICONS["debug-inspector"]}
              message={`No matches for “${query}”`}
              detail="Try a tool name, part of the agent reply, or an iteration number"
            />
          )}

        {showContext && systemPrompt && promptMatches && (
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

        {showContext && toolsResolved && filteredTools.length > 0 && (
          <Section
            label="Tools available"
            badge={
              query
                ? `${filteredTools.length} of ${toolsResolved.tools.length}`
                : `${toolsResolved.tools.length}`
            }
          >
            <div className="space-y-1.5">
              {filteredTools.map((t) => (
                <ToolDefinition key={t.name} tool={t} />
              ))}
            </div>
          </Section>
        )}

        {showContext && filteredSql.length > 0 && (
          <Section
            label="SQL quality"
            badge={
              query
                ? `${filteredSql.length} of ${sqlQualityEntries.length}`
                : `${sqlQualityEntries.length}`
            }
          >
            <div className="space-y-1.5">
              {filteredSql.map((entry, index) => {
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
          visibleCallIndexes.map((i) => {
            const call = llmCalls[i]!
            return (
              <LlmCallEntry
                key={`llm-${call.request.iteration}-${i}`}
                call={call}
                index={i}
                partsMode={partsMode}
                open={openCalls.has(i)}
                onToggle={() => toggleCall(i)}
                searchHit={callHits?.get(i) ?? null}
              />
            )
          })}
      </div>
    </div>
  )
}
