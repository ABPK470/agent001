/**
 * Hybrid Trace DAG view — vertical LLM spine + soft tool/result branches.
 *
 * Flat peer handlers; open state is explicit Sets, not nested closures.
 */

import { Check, ChevronDown, ChevronRight, Copy, Search, X } from "lucide-react"
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { JsonViewer } from "../../components/JsonViewer"
import { fmtTokens, formatMs } from "../../lib/util"
import {
  messagePreview,
  searchCall,
  type TraceCallNode,
  type TraceCallSearchHit,
  type TraceDag,
  type TracePromptMessage,
  type TraceSqlQuality,
  type TraceToolCall,
} from "./build-trace-dag"

// ── Shared chrome ────────────────────────────────────────────────

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
}: {
  value: string
  ariaLabel: string
}) {
  const { copied, copyValue } = useCopyFeedback()
  return (
    <button
      type="button"
      className="trace-copy"
      onClick={(e) => copyValue(value, e)}
      aria-label={copied ? "Copied" : ariaLabel}
    >
      {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  )
}

function IdChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="trace-id">
      <span className="trace-id__label">{label}</span>
      <span className="trace-id__value font-mono">{value}</span>
      <CopyControl value={value} ariaLabel={`Copy ${label}`} />
    </span>
  )
}

function formatCharCount(n: number): string {
  return n.toLocaleString()
}

const TEXT_PREVIEW_CHARS = 400

function ExpandableText({
  text,
  className = "trace-prose",
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
          className="trace-more"
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

// ── Header ───────────────────────────────────────────────────────

function TraceHeader({
  dag,
  runId,
  threadId,
  search,
  onSearchChange,
  searchStatus,
}: {
  dag: TraceDag
  runId: string | null
  threadId: string | null
  search: string
  onSearchChange: (value: string) => void
  searchStatus: string | null
}) {
  const { stats } = dag
  return (
    <div className="trace-header shrink-0">
      <div className="trace-header__meta">
        {stats.callCount === 0 ? (
          <span>No model calls yet</span>
        ) : (
          <>
            <span>
              {stats.callCount} call{stats.callCount === 1 ? "" : "s"}
            </span>
            {stats.totalDuration > 0 && (
              <>
                <span className="trace-header__sep" aria-hidden />
                <span className="tabular-nums">{formatMs(stats.totalDuration)}</span>
              </>
            )}
            {(stats.promptTokens > 0 || stats.completionTokens > 0) && (
              <>
                <span className="trace-header__sep" aria-hidden />
                <span className="tabular-nums text-text-muted">
                  {fmtTokens(stats.promptTokens)} in
                  <span className="opacity-40"> · </span>
                  {fmtTokens(stats.completionTokens)} out
                </span>
              </>
            )}
          </>
        )}
      </div>

      {(runId || threadId) && (
        <div className="trace-header__ids">
          {runId && <IdChip label="run" value={runId} />}
          {threadId && <IdChip label="thread" value={threadId} />}
        </div>
      )}

      <div className="trace-search">
        <Search size={14} className="trace-search__icon" />
        <input
          type="search"
          placeholder="Filter calls, tools, reply…"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="trace-search__input"
          aria-label="Filter trace"
        />
        {search && (
          <button
            type="button"
            className="trace-search__clear"
            onClick={() => onSearchChange("")}
            aria-label="Clear filter"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {searchStatus && (
        <div className="trace-search__status">{searchStatus}</div>
      )}
    </div>
  )
}

// ── Prompt history (secondary) ───────────────────────────────────

function PromptMessage({ msg }: { msg: TracePromptMessage }) {
  const [open, setOpen] = useState(false)
  const preview = messagePreview(msg)
  const isUserAnswer = msg.speaker === "User answer"

  return (
    <div className="trace-prompt-msg">
      <button
        type="button"
        className="trace-prompt-msg__btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown size={12} className="shrink-0 opacity-50" />
        ) : (
          <ChevronRight size={12} className="shrink-0 opacity-50" />
        )}
        <span className={isUserAnswer ? "text-text" : undefined}>{msg.speaker}</span>
        {msg.detail && <span className="opacity-50">{msg.detail}</span>}
        {!open && <span className="trace-prompt-msg__preview">{preview}</span>}
      </button>
      {open && (
        <div className="trace-prompt-msg__body">
          {msg.toolCallId && <IdChip label="tool call" value={msg.toolCallId} />}
          {msg.content && <ExpandableText text={msg.content} className="trace-prose-muted" />}
          {!msg.content && msg.toolCalls.length === 0 && (
            <span className="italic opacity-40">null</span>
          )}
          {msg.toolCalls.map((tc) => (
            <ToolBranch key={tc.id} tool={tc} compact />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Tool branch ──────────────────────────────────────────────────

function ToolBranch({
  tool,
  compact = false,
}: {
  tool: TraceToolCall
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`trace-branch${compact ? " is-compact" : ""}`}>
      <button
        type="button"
        className="trace-branch__btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown size={12} className="shrink-0 opacity-50" />
        ) : (
          <ChevronRight size={12} className="shrink-0 opacity-50" />
        )}
        <span className="font-mono">{tool.name}</span>
        <span className="trace-branch__id font-mono">{tool.id.slice(0, 10)}</span>
      </button>
      {open && (
        <div className="trace-branch__body">
          <IdChip label="tool call" value={tool.id} />
          <JsonViewer
            value={tool.arguments}
            label="arguments"
            defaultExpandDepth={1}
            maxHeight={220}
          />
        </div>
      )}
    </div>
  )
}

// ── Call spine node ──────────────────────────────────────────────

function CallNode({
  call,
  open,
  onToggle,
  searchHit,
}: {
  call: TraceCallNode
  open: boolean
  onToggle: () => void
  searchHit: TraceCallSearchHit | null
}) {
  const [promptOpen, setPromptOpen] = useState(false)

  useEffect(() => {
    if (searchHit?.inHistory) setPromptOpen(true)
  }, [searchHit])

  const usage = call.usage

  return (
    <div className={`trace-node${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="trace-node__head"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="trace-node__dot" aria-hidden />
        {open ? (
          <ChevronDown size={14} className="shrink-0 opacity-45" />
        ) : (
          <ChevronRight size={14} className="shrink-0 opacity-45" />
        )}
        <span className="trace-node__call tabular-nums">Call {call.index + 1}</span>
        <span className="trace-node__iter tabular-nums">iter {call.iteration + 1}</span>
        <span className="trace-node__headline">
          {call.headline}
          {searchHit && searchHit.reasons.length > 0 && (
            <span className="trace-node__match"> · matched {searchHit.reasons[0]}</span>
          )}
        </span>
        <span className="trace-node__meta tabular-nums">
          {usage && (
            <span title="Tokens in / out">
              {fmtTokens(usage.promptTokens)}
              <span className="opacity-35"> / </span>
              {fmtTokens(usage.completionTokens)}
            </span>
          )}
          {call.durationMs != null && <span>{formatMs(call.durationMs)}</span>}
        </span>
      </button>

      {open && (
        <div className="trace-node__body">
          <div className="trace-result">
            <div className="trace-result__label">Result</div>

            {call.waiting && (
              <p className="trace-prose opacity-55 italic">Waiting for reply…</p>
            )}

            {!call.waiting && call.content && (
              <ExpandableText
                text={call.content}
                maxExpandedHeight={480}
              />
            )}

            {!call.waiting && call.toolBranches.length > 0 && (
              <div className="trace-branches">
                <div className="trace-result__sub">
                  Called {call.toolBranches.length} tool
                  {call.toolBranches.length === 1 ? "" : "s"}
                </div>
                {call.toolBranches.map((tc) => (
                  <ToolBranch key={tc.id} tool={tc} />
                ))}
              </div>
            )}

            {call.askedUser && (
              <p className="trace-result__note">
                Waiting on the human — their answer appears on the next call as{" "}
                <span className="text-text-secondary">User answer</span>.
              </p>
            )}

            {!call.waiting &&
              call.toolBranches.length === 0 &&
              !call.content && (
                <p className="trace-prose text-error/70 italic">
                  Empty reply — no text and no tool calls
                </p>
              )}

            {call.sqlQuality.length > 0 && (
              <div className="trace-sql-inline">
                {call.sqlQuality.map((entry, i) => (
                  <SqlQualityRow key={`${entry.toolCallId}-${i}`} entry={entry} />
                ))}
              </div>
            )}
          </div>

          <div className="trace-prompt">
            <button
              type="button"
              className="trace-prompt__toggle"
              onClick={() => setPromptOpen((v) => !v)}
              aria-expanded={promptOpen}
            >
              {promptOpen ? (
                <ChevronDown size={12} className="shrink-0 opacity-45" />
              ) : (
                <ChevronRight size={12} className="shrink-0 opacity-45" />
              )}
              <span>Prompt sent to model</span>
              <span className="opacity-45">
                {call.messageCount} message{call.messageCount === 1 ? "" : "s"}
              </span>
            </button>
            {promptOpen && (
              <div className="trace-prompt__list">
                {call.messages.length === 0 ? (
                  <span className="italic opacity-40 pl-5">No messages recorded</span>
                ) : (
                  call.messages.map((msg, mi) => (
                    <PromptMessage key={`${call.iteration}-${mi}`} msg={msg} />
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Context preamble ─────────────────────────────────────────────

function SqlQualityRow({ entry }: { entry: TraceSqlQuality }) {
  const notes: string[] = []
  if (entry.validationCode) notes.push(`blocked=${entry.validationCode}`)
  if (entry.missingPersistedMirrorCandidates.length > 0) {
    notes.push(`mirror=${entry.missingPersistedMirrorCandidates.join(",")}`)
  }
  return (
    <div className="trace-sql-row">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="font-medium text-text">{entry.phase}</span>
        <span className="font-mono text-text-secondary">{entry.toolName}</span>
        <span className="text-text-muted text-sm">
          Iteration {entry.iteration + 1}
        </span>
        {entry.durationMs != null && (
          <span className="text-text-muted text-sm ml-auto">
            {formatMs(entry.durationMs)}
          </span>
        )}
      </div>
      <div className="text-sm text-text-muted mt-0.5">
        {notes.join(" · ") || "ok"}
      </div>
      {entry.sqlPreview && (
        <ExpandableText
          text={entry.sqlPreview}
          className="code-pre mt-1"
          previewChars={240}
          maxExpandedHeight={280}
        />
      )}
    </div>
  )
}

function ToolDef({
  tool,
}: {
  tool: { name: string; description: string; parameters?: Record<string, unknown> }
}) {
  const [showSchema, setShowSchema] = useState(false)
  return (
    <div className="trace-tool-def">
      <div className="flex items-start gap-2 min-w-0">
        <span className="font-mono font-medium text-text shrink-0">{tool.name}</span>
        <ExpandableText
          text={tool.description}
          className="trace-prose-muted"
          previewChars={160}
        />
      </div>
      {tool.parameters && (
        <>
          <button
            type="button"
            className="trace-more"
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

function PreambleNode({
  dag,
  open,
  onToggle,
  query,
}: {
  dag: TraceDag
  open: boolean
  onToggle: () => void
  query: string
}) {
  const { preamble } = dag
  const q = query.trim().toLowerCase()
  const promptMatches =
    !q || (preamble.systemPrompt?.toLowerCase().includes(q) ?? false)
  const tools = !q
    ? preamble.tools
    : preamble.tools.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q),
      )
  const sql = !q
    ? preamble.sqlQuality
    : preamble.sqlQuality.filter(
        (entry) =>
          entry.toolName.toLowerCase().includes(q) ||
          entry.phase.toLowerCase().includes(q) ||
          entry.sqlPreview.toLowerCase().includes(q) ||
          (entry.validationCode?.toLowerCase().includes(q) ?? false),
      )

  const hasAny =
    (preamble.systemPrompt && promptMatches) ||
    tools.length > 0 ||
    sql.length > 0
  if (!hasAny && !preamble.systemPrompt && preamble.tools.length === 0 && preamble.sqlQuality.length === 0) {
    return null
  }

  const bits: string[] = []
  if (preamble.systemPrompt) bits.push("prompt")
  if (preamble.tools.length > 0) bits.push(`${preamble.tools.length} tools`)
  if (preamble.sqlQuality.length > 0) bits.push(`${preamble.sqlQuality.length} sql`)

  return (
    <div className={`trace-node trace-preamble${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="trace-node__head"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="trace-node__dot is-soft" aria-hidden />
        {open ? (
          <ChevronDown size={14} className="shrink-0 opacity-45" />
        ) : (
          <ChevronRight size={14} className="shrink-0 opacity-45" />
        )}
        <span className="trace-node__call">Context</span>
        <span className="trace-node__headline opacity-60">
          {bits.join(" · ") || "empty"}
        </span>
      </button>
      {open && (
        <div className="trace-node__body trace-preamble__body">
          {preamble.systemPrompt && promptMatches && (
            <section className="trace-ctx-section">
              <div className="trace-result__label">
                System prompt
                <span className="opacity-45 font-normal normal-case tracking-normal ml-2">
                  {formatCharCount(preamble.systemPrompt.length)} chars
                </span>
                <span className="ml-auto">
                  <CopyControl value={preamble.systemPrompt} ariaLabel="Copy prompt" />
                </span>
              </div>
              <ExpandableText
                text={preamble.systemPrompt}
                className="code-pre"
                previewChars={500}
                maxExpandedHeight={500}
              />
            </section>
          )}
          {tools.length > 0 && (
            <section className="trace-ctx-section">
              <div className="trace-result__label">
                Tools available
                <span className="opacity-45 font-normal normal-case tracking-normal ml-2">
                  {q
                    ? `${tools.length} of ${preamble.tools.length}`
                    : String(tools.length)}
                </span>
              </div>
              <div className="space-y-2">
                {tools.map((t) => (
                  <ToolDef key={t.name} tool={t} />
                ))}
              </div>
            </section>
          )}
          {sql.length > 0 && (
            <section className="trace-ctx-section">
              <div className="trace-result__label">
                SQL quality
                <span className="opacity-45 font-normal normal-case tracking-normal ml-2">
                  {q
                    ? `${sql.length} of ${preamble.sqlQuality.length}`
                    : String(sql.length)}
                </span>
              </div>
              <div className="space-y-2">
                {sql.map((entry, i) => (
                  <SqlQualityRow key={`${entry.toolCallId}-${i}`} entry={entry} />
                ))}
              </div>
            </section>
          )}
          {!hasAny && q && (
            <p className="text-sm text-text-muted italic">No context matches</p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main DAG ─────────────────────────────────────────────────────

export function TraceDag({
  dag,
  runId,
  threadId,
  emptySlot,
}: {
  dag: TraceDag
  runId: string | null
  threadId: string | null
  emptySlot?: ReactNode
}) {
  const [search, setSearch] = useState("")
  const [openCalls, setOpenCalls] = useState<Set<number>>(() => new Set())
  const [preambleOpen, setPreambleOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const seededOpenRef = useRef(false)
  const searchOpenSeedRef = useRef("")

  const query = search.trim()

  const callHits = useMemo(() => {
    if (!query) return null
    const q = query.toLowerCase()
    const matchedRun = Boolean(runId && runId.toLowerCase().includes(q))
    const matchedThread = Boolean(threadId && threadId.toLowerCase().includes(q))
    const map = new Map<number, TraceCallSearchHit>()
    dag.calls.forEach((call) => {
      if (matchedRun || matchedThread) {
        map.set(call.index, {
          reasons: [matchedRun ? "run id" : "thread id"],
          inHistory: false,
          inReply: false,
        })
        return
      }
      const hit = searchCall(call, query)
      if (hit) map.set(call.index, hit)
    })
    return map
  }, [dag.calls, query, runId, threadId])

  useEffect(() => {
    if (seededOpenRef.current || dag.calls.length === 0) return
    seededOpenRef.current = true
    setOpenCalls(new Set([dag.calls.length - 1]))
  }, [dag.calls.length])

  useEffect(() => {
    seededOpenRef.current = false
    searchOpenSeedRef.current = ""
    setPreambleOpen(false)
  }, [runId])

  useEffect(() => {
    if (!query || !callHits) {
      searchOpenSeedRef.current = ""
      return
    }
    if (searchOpenSeedRef.current === query) return
    searchOpenSeedRef.current = query
    setOpenCalls(new Set(callHits.keys()))
  }, [query, callHits])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distance < 80) el.scrollTop = el.scrollHeight
  }, [dag.calls.length])

  const visibleIndexes = useMemo(() => {
    if (!callHits) return dag.calls.map((c) => c.index)
    return [...callHits.keys()]
  }, [dag.calls, callHits])

  const searchStatus = useMemo(() => {
    if (!query) return null
    if (dag.calls.length === 0) return null
    const n = callHits?.size ?? 0
    if (n === 0) return "No matching calls"
    return `${n} of ${dag.calls.length} calls`
  }, [query, callHits, dag.calls.length])

  function onToggleCall(index: number) {
    setOpenCalls((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  function onSearchChange(value: string) {
    setSearch(value)
  }

  function onTogglePreamble() {
    setPreambleOpen((v) => !v)
  }

  return (
    <div className="trace-dag flex flex-col h-full gap-2">
      <TraceHeader
        dag={dag}
        runId={runId}
        threadId={threadId}
        search={search}
        onSearchChange={onSearchChange}
        searchStatus={searchStatus}
      />

      <div ref={scrollRef} className="trace-spine min-h-0 flex-1 overflow-y-auto pr-1">
        {emptySlot}

        {runId &&
          dag.hasData &&
          query &&
          visibleIndexes.length === 0 && (
            <p className="text-sm text-text-muted px-1 py-3">
              No matches for “{query}”
            </p>
          )}

        {runId && dag.hasData && (
          <>
            <PreambleNode
              dag={dag}
              open={preambleOpen}
              onToggle={onTogglePreamble}
              query={query}
            />
            <div className="trace-rail" aria-hidden={!dag.calls.length}>
              {visibleIndexes.map((i) => {
                const call = dag.calls[i]!
                return (
                  <CallNode
                    key={`llm-${call.iteration}-${i}`}
                    call={call}
                    open={openCalls.has(i)}
                    onToggle={() => onToggleCall(i)}
                    searchHit={callHits?.get(i) ?? null}
                  />
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
