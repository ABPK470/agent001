/**
 * Trace outline — chronological scopes with VS Code–style pin stack.
 *
 * Flow per call: Sent → Received → Next (tools).
 * Scroll treats the list as one document: Call 1 → 2 → 3 accumulate
 * flush at the top; Sent/Received of the current call stack under it.
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
import {
  applyTracePinStack,
  computePinnedScopeIds,
  type TraceScopeKind,
} from "./trace-pin"

// ── Open-state (explicit, flat) ──────────────────────────────────

type OpenState = {
  preamble: boolean
  calls: Set<number>
  sent: Set<number>
  received: Set<number>
  messages: Set<string>
  tools: Set<string>
}

function emptyOpen(): OpenState {
  return {
    preamble: false,
    calls: new Set(),
    sent: new Set(),
    received: new Set(),
    messages: new Set(),
    tools: new Set(),
  }
}

function seedLatest(callCount: number): OpenState {
  const next = emptyOpen()
  if (callCount === 0) return next
  next.calls.add(callCount - 1)
  return next
}

// ── Shared helpers ───────────────────────────────────────────────

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
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
        setCopied(true)
        clearTimerRef.current = setTimeout(() => {
          setCopied(false)
          clearTimerRef.current = null
        }, 1600)
      })
      .catch(() => { /* ignore */ })
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

function shortLine(text: string, max = 72): string {
  const line = text.replace(/\s+/g, " ").trim()
  if (!line) return ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function ScopeRow({
  scopeId,
  kind,
  callIndex,
  open,
  onToggle,
  leading,
  title,
  summary,
  trailing,
  soft = false,
}: {
  scopeId: string
  kind: TraceScopeKind
  callIndex?: number | null
  open: boolean
  onToggle: () => void
  leading: string
  title?: string
  summary?: string
  trailing?: ReactNode
  soft?: boolean
}) {
  return (
    <button
      type="button"
      data-trace-scope={scopeId}
      data-trace-kind={kind}
      data-trace-call={callIndex == null ? "" : String(callIndex)}
      className={`trace-scope${open ? " is-open" : ""}${soft ? " is-soft" : ""}`}
      onClick={onToggle}
      aria-expanded={open}
    >
      {open ? (
        <ChevronDown size={14} className="trace-scope__chev" />
      ) : (
        <ChevronRight size={14} className="trace-scope__chev" />
      )}
      <span className="trace-scope__lead">{leading}</span>
      {title ? <span className="trace-scope__title">{title}</span> : null}
      {summary ? <span className="trace-scope__sum">{summary}</span> : null}
      {trailing ? <span className="trace-scope__trail">{trailing}</span> : null}
    </button>
  )
}

function ExpandableText({
  text,
  className,
  previewChars = 280,
}: {
  text: string
  className: string
  previewChars?: number
}) {
  const [expanded, setExpanded] = useState(false)
  const isLong = text.length > previewChars

  useEffect(() => {
    setExpanded(false)
  }, [text])

  const display = !isLong || expanded ? text : `${text.slice(0, previewChars)}…`

  return (
    <div className={`trace-expand${isLong && !expanded ? " is-clipped" : ""}`}>
      <pre className={className}>{display}</pre>
      {isLong && (
        <div className="trace-more-bar">
          <button
            type="button"
            className="trace-more"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? "Show less" : `Show more · ${formatCharCount(text.length)} chars`}
          </button>
        </div>
      )}
    </div>
  )
}

function PromptMessageRow({
  msg,
  open,
  onToggle,
}: {
  msg: TracePromptMessage
  open: boolean
  onToggle: () => void
}) {
  const preview = messagePreview(msg)
  const isUserAnswer = msg.speaker === "User answer"

  return (
    <div className="trace-row">
      <button
        type="button"
        className="trace-row__btn"
        onClick={onToggle}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown size={12} className="trace-scope__chev" />
        ) : (
          <ChevronRight size={12} className="trace-scope__chev" />
        )}
        <span className={isUserAnswer ? "trace-row__speaker is-em" : "trace-row__speaker"}>
          {msg.speaker}
        </span>
        {msg.detail && <span className="trace-row__detail">{msg.detail}</span>}
        {!open && <span className="trace-row__preview">{preview}</span>}
      </button>
      {open && (
        <div className="trace-row__body">
          {msg.toolCallId && <IdChip label="tool call" value={msg.toolCallId} />}
          {msg.content && (
            <ExpandableText text={msg.content} className="trace-body-muted" />
          )}
          {!msg.content && msg.toolCalls.length === 0 && (
            <span className="trace-empty">null</span>
          )}
          {msg.toolCalls.map((tc) => (
            <div key={tc.id} className="trace-tool-inline">
              <span className="font-mono">{tc.name}</span>
              <IdChip label="tool call" value={tc.id} />
              <JsonViewer
                value={tc.arguments}
                label="arguments"
                defaultExpandDepth={0}
                maxHeight={160}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ToolRow({
  tool,
  open,
  onToggle,
}: {
  tool: TraceToolCall
  open: boolean
  onToggle: () => void
}) {
  return (
    <div className="trace-row">
      <button
        type="button"
        className="trace-row__btn"
        onClick={onToggle}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown size={12} className="trace-scope__chev" />
        ) : (
          <ChevronRight size={12} className="trace-scope__chev" />
        )}
        <span className="font-mono text-sm">{tool.name}</span>
        {!open && (
          <span className="trace-row__preview font-mono">{tool.id.slice(0, 12)}</span>
        )}
      </button>
      {open && (
        <div className="trace-row__body">
          <IdChip label="tool call" value={tool.id} />
          <JsonViewer
            value={tool.arguments}
            label="arguments"
            defaultExpandDepth={1}
            maxHeight={200}
          />
        </div>
      )}
    </div>
  )
}

function SqlQualityRow({ entry }: { entry: TraceSqlQuality }) {
  const notes: string[] = []
  if (entry.validationCode) notes.push(`blocked=${entry.validationCode}`)
  if (entry.missingPersistedMirrorCandidates.length > 0) {
    notes.push(`mirror=${entry.missingPersistedMirrorCandidates.join(",")}`)
  }
  return (
    <div className="trace-ctx-item">
      <div className="trace-ctx-item__head">
        <span>{entry.phase}</span>
        <span className="font-mono">{entry.toolName}</span>
        <span className="trace-row__detail">iter {entry.iteration + 1}</span>
        {entry.durationMs != null && (
          <span className="trace-row__detail ml-auto">{formatMs(entry.durationMs)}</span>
        )}
      </div>
      <div className="trace-row__detail">{notes.join(" · ") || "ok"}</div>
      {entry.sqlPreview && (
        <ExpandableText
          text={entry.sqlPreview}
          className="code-pre"
          previewChars={180}
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
    <div className="trace-ctx-item">
      <div className="trace-ctx-item__head">
        <span className="font-mono">{tool.name}</span>
      </div>
      <ExpandableText
        text={tool.description}
        className="trace-body-muted"
        previewChars={120}
      />
      {tool.parameters && (
        <>
          <button
            type="button"
            className="trace-more"
            onClick={() => setShowSchema((v) => !v)}
            aria-expanded={showSchema}
          >
            {showSchema ? "Hide schema" : "Show schema"}
          </button>
          {showSchema && (
            <JsonViewer
              value={tool.parameters}
              label="schema"
              defaultExpandDepth={1}
              maxHeight={180}
            />
          )}
        </>
      )}
    </div>
  )
}

function callSentSummary(call: TraceCallNode): string {
  const n = call.messageCount
  const firstUser = call.messages.find((m) => m.role === "user" || m.speaker === "User")
  const peek = firstUser?.content ? shortLine(firstUser.content, 48) : ""
  if (peek) return `${n} messages · ${peek}`
  return `${n} message${n === 1 ? "" : "s"} to model`
}

function callReceivedSummary(call: TraceCallNode): string {
  if (call.waiting) return "Waiting…"
  if (call.content) return shortLine(call.content, 56) || "Final answer"
  if (call.toolBranches.length > 0) {
    return call.toolBranches.map((t) => t.name).join(", ")
  }
  return "Empty reply"
}

function CallOutline({
  call,
  openState,
  searchHit,
  onToggleCall,
  onToggleSent,
  onToggleReceived,
  onToggleMessage,
  onToggleTool,
}: {
  call: TraceCallNode
  openState: OpenState
  searchHit: TraceCallSearchHit | null
  onToggleCall: (index: number) => void
  onToggleSent: (index: number) => void
  onToggleReceived: (index: number) => void
  onToggleMessage: (key: string) => void
  onToggleTool: (id: string) => void
}) {
  const callOpen = openState.calls.has(call.index)
  const sentOpen = openState.sent.has(call.index)
  const receivedOpen = openState.received.has(call.index)
  const usage = call.usage

  return (
    <div className="trace-call">
      <ScopeRow
        scopeId={`call:${call.index}`}
        kind="call"
        callIndex={call.index}
        open={callOpen}
        onToggle={() => onToggleCall(call.index)}
        leading={`Call ${call.index + 1}`}
        title={call.headline}
        summary={
          searchHit?.reasons[0]
            ? `matched ${searchHit.reasons[0]}`
            : `iter ${call.iteration + 1}`
        }
        trailing={
          <>
            {usage && (
              <span className="tabular-nums">
                {fmtTokens(usage.promptTokens)}/{fmtTokens(usage.completionTokens)}
              </span>
            )}
            {call.durationMs != null && (
              <span className="tabular-nums">{formatMs(call.durationMs)}</span>
            )}
          </>
        }
      />

      {callOpen && (
        <div className="trace-call-panel">
          <ScopeRow
            scopeId={`sent:${call.index}`}
            kind="sent"
            callIndex={call.index}
            open={sentOpen}
            onToggle={() => onToggleSent(call.index)}
            leading="Sent"
            summary={callSentSummary(call)}
            soft
          />
          {sentOpen && (
            <div className="trace-scope-body">
              {call.messages.length === 0 ? (
                <span className="trace-empty">No messages recorded</span>
              ) : (
                call.messages.map((msg, mi) => {
                  const key = `${call.iteration}:m:${mi}`
                  return (
                    <PromptMessageRow
                      key={key}
                      msg={msg}
                      open={openState.messages.has(key)}
                      onToggle={() => onToggleMessage(key)}
                    />
                  )
                })
              )}
            </div>
          )}

          <ScopeRow
            scopeId={`received:${call.index}`}
            kind="received"
            callIndex={call.index}
            open={receivedOpen}
            onToggle={() => onToggleReceived(call.index)}
            leading="Received"
            summary={callReceivedSummary(call)}
            soft
          />
          {receivedOpen && (
            <div className="trace-scope-body">
              {call.waiting && <span className="trace-empty">Waiting for reply…</span>}
              {!call.waiting && call.content && (
                <ExpandableText text={call.content} className="trace-body-reply" />
              )}
              {!call.waiting &&
                call.toolBranches.length === 0 &&
                !call.content && (
                  <span className="trace-empty is-error">
                    Empty reply — no text and no tool calls
                  </span>
                )}
              {call.askedUser && (
                <p className="trace-note">
                  Waiting on human — answer lands on the next call as User answer.
                </p>
              )}
              {call.sqlQuality.map((entry, i) => (
                <SqlQualityRow key={`${entry.toolCallId}-${i}`} entry={entry} />
              ))}
            </div>
          )}

          {call.toolBranches.length > 0 && (
            <div className="trace-next">
              <div className="trace-next__label">
                Next
                <span className="trace-row__detail">
                  {call.toolBranches.length} tool
                  {call.toolBranches.length === 1 ? "" : "s"}
                </span>
              </div>
              {call.toolBranches.map((tc) => (
                <ToolRow
                  key={tc.id}
                  tool={tc}
                  open={openState.tools.has(tc.id)}
                  onToggle={() => onToggleTool(tc.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function PreambleOutline({
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
  if (
    !preamble.systemPrompt &&
    preamble.tools.length === 0 &&
    preamble.sqlQuality.length === 0
  ) {
    return null
  }

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

  const bits: string[] = []
  if (preamble.systemPrompt) bits.push("prompt")
  if (preamble.tools.length > 0) bits.push(`${preamble.tools.length} tools`)
  if (preamble.sqlQuality.length > 0) bits.push(`${preamble.sqlQuality.length} sql`)

  return (
    <div className="trace-call">
      <ScopeRow
        scopeId="context"
        kind="context"
        open={open}
        onToggle={onToggle}
        leading="Context"
        summary={bits.join(" · ") || "empty"}
        soft
      />
      {open && (
        <div className="trace-call-panel">
          {preamble.systemPrompt && promptMatches && (
            <div className="trace-scope-body">
              <div className="trace-next__label">
                System prompt
                <span className="trace-row__detail">
                  {formatCharCount(preamble.systemPrompt.length)} chars
                </span>
                <CopyControl value={preamble.systemPrompt} ariaLabel="Copy prompt" />
              </div>
              <ExpandableText
                text={preamble.systemPrompt}
                className="trace-body-muted"
                previewChars={360}
              />
            </div>
          )}
          {tools.length > 0 && (
            <div className="trace-scope-body">
              <div className="trace-next__label">
                Tools
                <span className="trace-row__detail">
                  {q ? `${tools.length} of ${preamble.tools.length}` : tools.length}
                </span>
              </div>
              {tools.map((t) => (
                <ToolDef key={t.name} tool={t} />
              ))}
            </div>
          )}
          {sql.length > 0 && (
            <div className="trace-scope-body">
              <div className="trace-next__label">SQL quality</div>
              {sql.map((entry, i) => (
                <SqlQualityRow key={`${entry.toolCallId}-${i}`} entry={entry} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main ─────────────────────────────────────────────────────────

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
  const [openState, setOpenState] = useState<OpenState>(() => emptyOpen())
  const scrollRef = useRef<HTMLDivElement>(null)
  const seededRef = useRef(false)
  const searchSeedRef = useRef("")

  const query = search.trim()
  const { stats } = dag

  const callHits = useMemo(() => {
    if (!query) return null
    const q = query.toLowerCase()
    const matchedRun = Boolean(runId && runId.toLowerCase().includes(q))
    const matchedThread = Boolean(threadId && threadId.toLowerCase().includes(q))
    const map = new Map<number, TraceCallSearchHit>()
    for (const call of dag.calls) {
      if (matchedRun || matchedThread) {
        map.set(call.index, {
          reasons: [matchedRun ? "run id" : "thread id"],
          inHistory: false,
          inReply: false,
        })
        continue
      }
      const hit = searchCall(call, query)
      if (hit) map.set(call.index, hit)
    }
    return map
  }, [dag.calls, query, runId, threadId])

  function refreshPin() {
    const el = scrollRef.current
    if (!el) return
    applyTracePinStack(el, computePinnedScopeIds(el))
  }

  useEffect(() => {
    if (seededRef.current || dag.calls.length === 0) return
    seededRef.current = true
    setOpenState(seedLatest(dag.calls.length))
  }, [dag.calls.length])

  useEffect(() => {
    seededRef.current = false
    searchSeedRef.current = ""
    setOpenState(emptyOpen())
  }, [runId])

  useEffect(() => {
    if (!query || !callHits) {
      searchSeedRef.current = ""
      return
    }
    if (searchSeedRef.current === query) return
    searchSeedRef.current = query
    setOpenState((prev) => {
      const next: OpenState = {
        ...prev,
        calls: new Set(callHits.keys()),
        sent: new Set(prev.sent),
        received: new Set(prev.received),
      }
      for (const [i, hit] of callHits) {
        if (hit.inHistory) next.sent.add(i)
        if (hit.inReply) next.received.add(i)
        if (!hit.inHistory && !hit.inReply) {
          next.sent.add(i)
          next.received.add(i)
        }
      }
      return next
    })
  }, [query, callHits])

  const visibleIndexesList = useMemo(
    () => visibleIndexes(dag, callHits),
    [dag, callHits],
  )

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    function onScroll() {
      refreshPin()
    }

    el.addEventListener("scroll", onScroll, { passive: true })
    const raf = requestAnimationFrame(() => refreshPin())
    return () => {
      el.removeEventListener("scroll", onScroll)
      cancelAnimationFrame(raf)
    }
  }, [
    dag.calls.length,
    openState.calls,
    openState.sent,
    openState.received,
    openState.preamble,
    visibleIndexesList,
  ])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distance < 80) el.scrollTop = el.scrollHeight
  }, [dag.calls.length])

  function onToggleCall(index: number) {
    setOpenState((prev) => {
      const calls = new Set(prev.calls)
      if (calls.has(index)) calls.delete(index)
      else calls.add(index)
      return { ...prev, calls }
    })
  }

  function onToggleSent(index: number) {
    setOpenState((prev) => {
      const sent = new Set(prev.sent)
      if (sent.has(index)) sent.delete(index)
      else sent.add(index)
      return { ...prev, sent }
    })
  }

  function onToggleReceived(index: number) {
    setOpenState((prev) => {
      const received = new Set(prev.received)
      if (received.has(index)) received.delete(index)
      else received.add(index)
      return { ...prev, received }
    })
  }

  function onToggleMessage(key: string) {
    setOpenState((prev) => {
      const messages = new Set(prev.messages)
      if (messages.has(key)) messages.delete(key)
      else messages.add(key)
      return { ...prev, messages }
    })
  }

  function onToggleTool(id: string) {
    setOpenState((prev) => {
      const tools = new Set(prev.tools)
      if (tools.has(id)) tools.delete(id)
      else tools.add(id)
      return { ...prev, tools }
    })
  }

  function onTogglePreamble() {
    setOpenState((prev) => ({ ...prev, preamble: !prev.preamble }))
  }

  function onExpandAll() {
    setOpenState({
      preamble: true,
      calls: new Set(dag.calls.map((c) => c.index)),
      sent: new Set(dag.calls.map((c) => c.index)),
      received: new Set(dag.calls.map((c) => c.index)),
      messages: new Set(
        dag.calls.flatMap((c) =>
          c.messages.map((_, mi) => `${c.iteration}:m:${mi}`),
        ),
      ),
      tools: new Set(dag.calls.flatMap((c) => c.toolBranches.map((t) => t.id))),
    })
  }

  function onCollapseAll() {
    setOpenState(emptyOpen())
  }

  function onSearchChange(value: string) {
    setSearch(value)
  }

  const searchStatus =
    query && dag.calls.length > 0
      ? `${callHits?.size ?? 0} of ${dag.calls.length} calls`
      : null

  return (
    <div className="trace-dag flex flex-col h-full min-h-0">
      <div className="trace-toolbar shrink-0">
        <div className="trace-toolbar__row">
          <div className="trace-toolbar__meta">
            {stats.callCount === 0 ? (
              <span>No model calls yet</span>
            ) : (
              <>
                <span>
                  {stats.callCount} call{stats.callCount === 1 ? "" : "s"}
                </span>
                {stats.totalDuration > 0 && (
                  <span className="tabular-nums">{formatMs(stats.totalDuration)}</span>
                )}
                {(stats.promptTokens > 0 || stats.completionTokens > 0) && (
                  <span className="tabular-nums">
                    {fmtTokens(stats.promptTokens)} in · {fmtTokens(stats.completionTokens)} out
                  </span>
                )}
              </>
            )}
          </div>
          <div className="trace-toolbar__actions">
            <button type="button" className="trace-toolbtn" onClick={onExpandAll}>
              Expand all
            </button>
            <button type="button" className="trace-toolbtn" onClick={onCollapseAll}>
              Collapse all
            </button>
          </div>
        </div>

        {(runId || threadId) && (
          <div className="trace-toolbar__ids">
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
        {searchStatus && <div className="trace-search__status">{searchStatus}</div>}
      </div>

      <div ref={scrollRef} className="trace-scroll min-h-0 flex-1 overflow-y-auto">
        {emptySlot}

        {runId &&
          dag.hasData &&
          query &&
          visibleIndexesList.length === 0 && (
            <p className="trace-empty px-2 py-3">No matches for “{query}”</p>
          )}

        {runId && dag.hasData && (
          <div className="trace-flow">
            <PreambleOutline
              dag={dag}
              open={openState.preamble}
              onToggle={onTogglePreamble}
              query={query}
            />
            {visibleIndexesList.map((i) => {
              const call = dag.calls[i]!
              return (
                <CallOutline
                  key={`llm-${call.iteration}-${i}`}
                  call={call}
                  openState={openState}
                  searchHit={callHits?.get(i) ?? null}
                  onToggleCall={onToggleCall}
                  onToggleSent={onToggleSent}
                  onToggleReceived={onToggleReceived}
                  onToggleMessage={onToggleMessage}
                  onToggleTool={onToggleTool}
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function visibleIndexes(
  dag: TraceDag,
  callHits: Map<number, TraceCallSearchHit> | null,
): number[] {
  if (!callHits) return dag.calls.map((c) => c.index)
  return [...callHits.keys()]
}
