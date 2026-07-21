/**
 * Trace outline shell — toolbar + chronological call cards.
 *
 * Sticky scroll = Cursor/VS Code dialect on a nested document:
 * pin overlay shows the ancestor chain (Trace → Call → Sent → Message…);
 * clones keep full header chrome; click jumps to that scope.
 */

import { Search, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { fmtTokens, formatMs } from "../../lib/util"
import { SegmentToggle } from "../entity-registry/SegmentToggle"
import {
  messagePreview,
  searchCall,
  type TraceCallSearchHit,
  type TraceDag,
} from "./build-trace-dag"
import { emptyOpen, seedLatest, type FoldMode, type OpenState } from "./open-state"
import { formatCharCount, callReceivedSummary, callSentSummary } from "./trace-format"
import {
  TRACE_STICKY_ROW_H,
  callIndexForTool,
  computePinnedScopeIds,
  expandPathForScope,
  layoutOffsetInScroll,
} from "./trace-pin"
import { CallOutline } from "./TraceCall"
import { PreambleOutline } from "./TraceContext"
import { IdChip } from "./TraceCopy"
import { PinOverlay, type PinRow, ScopeRow } from "./TraceScope"

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
  const [pinnedIds, setPinnedIds] = useState<string[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const seededRef = useRef(false)
  const searchSeedRef = useRef("")
  const suppressFollowRef = useRef(false)

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

  function refreshPinStack() {
    const el = scrollRef.current
    if (!el) return
    const ids = computePinnedScopeIds(el)
    el.style.setProperty(
      "--trace-pin-stack-h",
      `${ids.length * TRACE_STICKY_ROW_H}px`,
    )
    setPinnedIds(ids)
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
    setPinnedIds([])
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
      refreshPinStack()
    }

    el.addEventListener("scroll", onScroll, { passive: true })
    const ro = new ResizeObserver(() => {
      refreshPinStack()
    })
    ro.observe(el)
    const raf = requestAnimationFrame(() => refreshPinStack())
    return () => {
      el.removeEventListener("scroll", onScroll)
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [
    dag.calls.length,
    openState.calls,
    openState.sent,
    openState.received,
    openState.messages,
    openState.tools,
    openState.preamble,
    openState.contextPrompt,
    openState.contextTools,
    visibleIndexesList,
  ])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || suppressFollowRef.current) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distance < 80) el.scrollTop = el.scrollHeight
  }, [dag.calls.length])

  const contextSummary = useMemo(() => {
    const bits: string[] = []
    if (dag.preamble.systemPrompt) bits.push("prompt")
    if (dag.preamble.tools.length > 0) {
      bits.push(`${dag.preamble.tools.length} tools`)
    }
    return bits.join(" · ") || "empty"
  }, [dag.preamble])

  const pinRows = useMemo((): PinRow[] => {
    const rows: PinRow[] = []
    for (const id of pinnedIds) {
      if (id === "trace") {
        rows.push({
          id,
          kind: "trace",
          depth: 0,
          leading: "Trace",
          title: "",
          summary:
            stats.callCount === 0
              ? "empty"
              : `${stats.callCount} call${stats.callCount === 1 ? "" : "s"}`,
          soft: false,
          open: true,
          foldable: false,
        })
        continue
      }
      if (id === "context") {
        rows.push({
          id,
          kind: "context",
          depth: 1,
          leading: "Context",
          title: "",
          summary: contextSummary,
          soft: true,
          open: openState.preamble,
        })
        continue
      }
      if (id === "prompt") {
        const prompt = dag.preamble.systemPrompt ?? ""
        rows.push({
          id,
          kind: "prompt",
          depth: 2,
          leading: "Prompt",
          title: "",
          summary: prompt ? `${formatCharCount(prompt.length)} chars` : "",
          soft: true,
          open: openState.contextPrompt,
        })
        continue
      }
      if (id === "tools") {
        rows.push({
          id,
          kind: "tools",
          depth: 2,
          leading: "Tools",
          title: "",
          summary: String(dag.preamble.tools.length),
          soft: true,
          open: openState.contextTools,
        })
        continue
      }
      const callMatch = /^call:(\d+)$/.exec(id)
      if (callMatch) {
        const index = Number(callMatch[1])
        const call = dag.calls[index]
        if (!call) continue
        const usage = call.usage
        rows.push({
          id,
          kind: "call",
          depth: 1,
          leading: `Call ${index + 1}`,
          title: call.headline,
          summary: `iter ${call.iteration + 1}`,
          soft: false,
          open: openState.calls.has(index),
          trailing: (
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
          ),
        })
        continue
      }
      const sentMatch = /^sent:(\d+)$/.exec(id)
      if (sentMatch) {
        const index = Number(sentMatch[1])
        const call = dag.calls[index]
        if (!call) continue
        rows.push({
          id,
          kind: "sent",
          depth: 2,
          leading: "Sent",
          title: "",
          summary: callSentSummary(call),
          soft: true,
          open: openState.sent.has(index),
        })
        continue
      }
      const recvMatch = /^received:(\d+)$/.exec(id)
      if (recvMatch) {
        const index = Number(recvMatch[1])
        const call = dag.calls[index]
        if (!call) continue
        rows.push({
          id,
          kind: "received",
          depth: 2,
          leading: "Received",
          title: "",
          summary: callReceivedSummary(call),
          soft: true,
          open: openState.received.has(index),
        })
        continue
      }
      const msgMatch = /^message:(\d+):m:(\d+)$/.exec(id)
      if (msgMatch) {
        const index = Number(msgMatch[1])
        const mi = Number(msgMatch[2])
        const call = dag.calls[index]
        const msg = call?.messages[mi]
        if (!call || !msg) continue
        const key = `${index}:m:${mi}`
        rows.push({
          id,
          kind: "message",
          depth: 3,
          leading: msg.speaker,
          title: msg.detail ?? "",
          summary: openState.messages.has(key)
            ? (msg.toolCallId ?? "")
            : messagePreview(msg),
          soft: false,
          open: openState.messages.has(key),
        })
        continue
      }
      const toolMatch = /^tool:(.+)$/.exec(id)
      if (toolMatch) {
        const toolId = toolMatch[1]!
        const callIndex = callIndexForTool(toolId, dag.calls)
        if (callIndex == null) continue
        const call = dag.calls[callIndex]
        const tool = call?.toolBranches.find((t) => t.id === toolId)
        if (!tool) continue
        rows.push({
          id,
          kind: "tool",
          depth: 3,
          leading: tool.name,
          title: "",
          summary: tool.id,
          soft: false,
          open: openState.tools.has(toolId),
        })
      }
    }
    return rows
  }, [pinnedIds, dag, openState, contextSummary, stats.callCount])

  function onTogglePinnedScope(scopeId: string) {
    if (scopeId === "trace") return
    if (scopeId === "context") {
      onTogglePreamble()
      return
    }
    if (scopeId === "prompt") {
      onToggleContextPrompt()
      return
    }
    if (scopeId === "tools") {
      onToggleContextTools()
      return
    }
    const callMatch = /^call:(\d+)$/.exec(scopeId)
    if (callMatch) {
      onToggleCall(Number(callMatch[1]))
      return
    }
    const sentMatch = /^sent:(\d+)$/.exec(scopeId)
    if (sentMatch) {
      onToggleSent(Number(sentMatch[1]))
      return
    }
    const recvMatch = /^received:(\d+)$/.exec(scopeId)
    if (recvMatch) {
      onToggleReceived(Number(recvMatch[1]))
      return
    }
    const msgMatch = /^message:(\d+):m:(\d+)$/.exec(scopeId)
    if (msgMatch) {
      onToggleMessage(`${msgMatch[1]}:m:${msgMatch[2]}`)
      return
    }
    const toolMatch = /^tool:(.+)$/.exec(scopeId)
    if (toolMatch) {
      onToggleTool(toolMatch[1]!)
    }
  }

  function onRevealScope(scopeId: string) {
    const path = expandPathForScope(scopeId)
    setOpenState((prev) => {
      const calls = new Set(prev.calls)
      const sent = new Set(prev.sent)
      const received = new Set(prev.received)
      const messages = new Set(prev.messages)
      const tools = new Set(prev.tools)
      let preamble = prev.preamble
      let contextPrompt = prev.contextPrompt
      let contextTools = prev.contextTools
      if (path.preamble) preamble = true
      if (path.contextPrompt) contextPrompt = true
      if (path.contextTools) contextTools = true
      let callIndex = path.callIndex
      if (path.toolId) {
        const found = callIndexForTool(path.toolId, dag.calls)
        if (found != null) callIndex = found
        tools.add(path.toolId)
      }
      if (callIndex != null) {
        calls.add(callIndex)
        if (path.sent) sent.add(callIndex)
        if (path.received) received.add(callIndex)
      }
      if (path.messageKey) messages.add(path.messageKey)
      return {
        ...prev,
        preamble,
        contextPrompt,
        contextTools,
        calls,
        sent,
        received,
        messages,
        tools,
      }
    })
    // VS Code: click sticky line → that line sits at its stack slot.
    suppressFollowRef.current = true
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = scrollRef.current
        if (!el) {
          suppressFollowRef.current = false
          return
        }
        const target = el.querySelector(
          `[data-trace-scope="${CSS.escape(scopeId)}"]`,
        )
        if (target instanceof HTMLElement) {
          const top = layoutOffsetInScroll(el, target)
          const depth = Number(target.dataset.traceDepth ?? "0") || 0
          el.scrollTop = Math.max(0, top - depth * TRACE_STICKY_ROW_H)
        }
        refreshPinStack()
        suppressFollowRef.current = false
      })
    })
  }

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

  function onToggleContextPrompt() {
    setOpenState((prev) => ({ ...prev, contextPrompt: !prev.contextPrompt }))
  }

  function onToggleContextTools() {
    setOpenState((prev) => ({ ...prev, contextTools: !prev.contextTools }))
  }

  function onFoldModeChange(mode: FoldMode) {
    if (mode === "expanded") {
      setOpenState({
        preamble: true,
        contextPrompt: true,
        contextTools: true,
        calls: new Set(dag.calls.map((c) => c.index)),
        sent: new Set(dag.calls.map((c) => c.index)),
        received: new Set(dag.calls.map((c) => c.index)),
        messages: new Set(
          dag.calls.flatMap((c) =>
            c.messages.map((_, mi) => `${c.index}:m:${mi}`),
          ),
        ),
        tools: new Set(dag.calls.flatMap((c) => c.toolBranches.map((t) => t.id))),
        foldMode: "expanded",
      })
      return
    }
    setOpenState({ ...emptyOpen(), foldMode: "collapsed" })
  }

  function onSearchChange(value: string) {
    setSearch(value)
  }

  const searchStatus =
    query && dag.calls.length > 0
      ? `${callHits?.size ?? 0} of ${dag.calls.length} calls`
      : null

  const traceSummary =
    stats.callCount === 0
      ? "empty"
      : `${stats.callCount} call${stats.callCount === 1 ? "" : "s"}`

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
                    {fmtTokens(stats.promptTokens)} in ·{" "}
                    {fmtTokens(stats.completionTokens)} out
                  </span>
                )}
              </>
            )}
          </div>
          <div className="trace-toolbar__actions">
            <SegmentToggle
              value={openState.foldMode}
              options={[
                { value: "expanded", label: "Expanded" },
                { value: "collapsed", label: "Collapsed" },
              ]}
              onChange={onFoldModeChange}
              ariaLabel="Expand or collapse all trace scopes"
            />
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
        <PinOverlay
          rows={pinRows}
          onToggle={onTogglePinnedScope}
          onReveal={onRevealScope}
        />

        {emptySlot}

        {runId &&
          dag.hasData &&
          query &&
          visibleIndexesList.length === 0 && (
            <p className="trace-empty px-2 py-3">No matches for “{query}”</p>
          )}

        {runId && dag.hasData && (
          <div className="trace-flow">
            <ScopeRow
              scopeId="trace"
              kind="trace"
              depth={0}
              open
              foldable={false}
              onToggle={() => {}}
              leading="Trace"
              summary={traceSummary}
            />
            <PreambleOutline
              dag={dag}
              open={openState.preamble}
              contextPromptOpen={openState.contextPrompt}
              contextToolsOpen={openState.contextTools}
              onToggle={onTogglePreamble}
              onTogglePrompt={onToggleContextPrompt}
              onToggleTools={onToggleContextTools}
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
