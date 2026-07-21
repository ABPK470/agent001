/**
 * Trace outline shell — toolbar + chronological call cards.
 *
 * Sticky headers = native CSS sticky on the real rows (no clone overlay).
 * Each Sent/Received/Prompt/Tools lives in a .trace-stick-block so siblings
 * unstick when you leave their block (VS Code ancestor-chain dialect).
 */

import { Search, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { fmtTokens, formatMs } from "../../lib/util"
import { SegmentToggle } from "../entity-registry/SegmentToggle"
import {
  searchCall,
  type TraceCallSearchHit,
  type TraceDag,
} from "./build-trace-dag"
import { emptyOpen, seedLatest, type FoldMode, type OpenState } from "./open-state"
import { CallOutline } from "./TraceCall"
import { PreambleOutline } from "./TraceContext"
import { IdChip } from "./TraceCopy"
import { PhaseOutline } from "./TracePhase"
import { WorkOutline } from "./TraceWork"

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

  useEffect(() => {
    if (seededRef.current || (dag.calls.length === 0 && dag.spine.length === 0)) return
    seededRef.current = true
    setOpenState((prev) => {
      const next = seedLatest(dag.calls.length)
      const lastCall = dag.calls.length - 1
      const lastWork = [...dag.spine].reverse().find((e) => e.kind === "work")
      if (lastWork && lastWork.kind === "work") {
        next.work.add(lastWork.work.id)
      }
      // Open step / subagent phases that own the latest call (or nested work).
      for (const entry of dag.spine) {
        if (entry.kind !== "phase" || !entry.phase.children?.length) continue
        const ownsLatest = entry.phase.children.some((child) => {
          if (child.kind === "call") return child.callIndex === lastCall
          if (child.kind === "work") {
            next.work.add(child.work.id)
            return child.work.afterCallIndex === lastCall
          }
          return false
        })
        if (ownsLatest) next.phases.add(entry.phase.id)
      }
      return { ...next, foldMode: prev.foldMode }
    })
  }, [dag.calls.length, dag.spine])

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

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distance < 80) el.scrollTop = el.scrollHeight
  }, [dag.calls.length, dag.spine.length])

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

  function onTogglePhase(id: string) {
    setOpenState((prev) => {
      const phases = new Set(prev.phases)
      if (phases.has(id)) phases.delete(id)
      else phases.add(id)
      return { ...prev, phases }
    })
  }

  function onToggleWork(id: string) {
    setOpenState((prev) => {
      const work = new Set(prev.work)
      if (work.has(id)) work.delete(id)
      else work.add(id)
      return { ...prev, work }
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
      const workTools = dag.spine.flatMap((e) =>
        e.kind === "work" ? e.work.tools.map((t) => t.id) : [],
      )
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
        tools: new Set([
          ...dag.calls.flatMap((c) => c.toolBranches.map((t) => t.id)),
          ...workTools,
        ]),
        phases: new Set(
          dag.spine.filter((e) => e.kind === "phase").map((e) => e.phase.id),
        ),
        work: new Set(
          dag.spine.filter((e) => e.kind === "work").map((e) => e.work.id),
        ),
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

  return (
    <div className="trace-dag flex flex-col h-full min-h-0">
      <div className="trace-toolbar shrink-0">
        <div className="trace-toolbar__row">
          <div className="trace-toolbar__meta">
            {stats.callCount === 0 && stats.toolRunCount === 0 ? (
              <span>No agent loop yet</span>
            ) : (
              <>
                {stats.callCount > 0 && (
                  <span>
                    {stats.callCount} call{stats.callCount === 1 ? "" : "s"}
                  </span>
                )}
                {stats.toolRunCount > 0 && (
                  <span>
                    {stats.toolRunCount} tool{stats.toolRunCount === 1 ? "" : "s"}
                  </span>
                )}
                {stats.phaseCount > 0 && (
                  <span>
                    {stats.phaseCount} phase{stats.phaseCount === 1 ? "" : "s"}
                  </span>
                )}
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
            placeholder="Filter calls, tools, work…"
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

      <div ref={scrollRef} className="trace-scroll min-h-0 flex-1" data-trace-scroll-host>
        {emptySlot}

        {runId &&
          dag.hasData &&
          query &&
          (callHits?.size ?? 0) === 0 && (
            <p className="trace-empty px-2 py-3">No matches for “{query}”</p>
          )}

        {runId && dag.hasData && (
          <div className="trace-flow">
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
            {dag.spine.map((entry) => {
              if (entry.kind === "phase") {
                const nested =
                  entry.phase.children && entry.phase.children.length > 0
                    ? entry.phase.children.map((child) => {
                        if (child.kind === "work") {
                          if (
                            query &&
                            callHits &&
                            !callHits.has(child.work.afterCallIndex)
                          ) {
                            return null
                          }
                          return (
                            <WorkOutline
                              key={child.work.id}
                              work={child.work}
                              open={openState.work.has(child.work.id)}
                              openState={openState}
                              onToggle={() => onToggleWork(child.work.id)}
                              onToggleTool={onToggleTool}
                              nested
                            />
                          )
                        }
                        const call = dag.calls[child.callIndex]
                        if (!call) return null
                        if (query && callHits && !callHits.has(call.index)) return null
                        return (
                          <CallOutline
                            key={`llm-${call.iteration}-${call.index}`}
                            call={call}
                            openState={openState}
                            searchHit={callHits?.get(call.index) ?? null}
                            onToggleCall={onToggleCall}
                            onToggleSent={onToggleSent}
                            onToggleReceived={onToggleReceived}
                            onToggleMessage={onToggleMessage}
                            onToggleTool={onToggleTool}
                            nested
                          />
                        )
                      })
                    : null
                return (
                  <PhaseOutline
                    key={entry.phase.id}
                    phase={entry.phase}
                    open={openState.phases.has(entry.phase.id)}
                    onToggle={() => onTogglePhase(entry.phase.id)}
                    nested={nested}
                  />
                )
              }
              if (entry.kind === "work") {
                if (query && callHits && !callHits.has(entry.work.afterCallIndex)) {
                  return null
                }
                return (
                  <WorkOutline
                    key={entry.work.id}
                    work={entry.work}
                    open={openState.work.has(entry.work.id)}
                    openState={openState}
                    onToggle={() => onToggleWork(entry.work.id)}
                    onToggleTool={onToggleTool}
                  />
                )
              }
              const call = dag.calls[entry.callIndex]
              if (!call) return null
              if (query && callHits && !callHits.has(call.index)) return null
              return (
                <CallOutline
                  key={`llm-${call.iteration}-${call.index}`}
                  call={call}
                  openState={openState}
                  searchHit={callHits?.get(call.index) ?? null}
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

