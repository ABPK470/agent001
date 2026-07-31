/**
 * Trace outline shell — toolbar + chronological cards.
 *
 * Sticky scroll = Cursor / VS Code dialect: a reserved pin band *above* the
 * scrollport clones the ancestor chain. Content never scrolls under the pins.
 * Band height changes are compensated with `pinBandScrollDelta` so peer
 * handoff does not cancel wheel scroll. Pins stay a frame sibling (never
 * inside the overflow node — they would scroll away).
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useTilePaint } from "../../app/workspace/tile-paint"
import { VirtualList } from "../../components/VirtualList"
import { fmtTokens, formatMs } from "../../lib/util"
import {
  offsetInScrollHost,
  parkScrollOnScope,
} from "../../lib/chatScroll"

/** Spine overscan — expanded cards are huge; 24 mounted a wall of DOM. */
export const TRACE_SPINE_OVERSCAN = 6
import { SegmentToggle } from "../entity-registry/SegmentToggle"
import {
  WIDGET_LOG_SHELL_CLASS,
  WIDGET_LOG_STACK_CLASS,
  WidgetToolbar,
  WidgetToolbarLeading,
  WidgetToolbarSearch,
  WidgetToolbarTrailing,
} from "../widget-toolbar"
import {
  messagePreview,
  searchCall,
  type TraceCallSearchHit,
  type TraceDag,
  type TraceSpineEntry,
} from "./build-trace-dag"
import {
  callToolOpenKey,
  emptyOpen,
  seedLatest,
  workToolOpenKey,
  type FoldMode,
  type OpenState,
} from "./open-state"
import { callReceivedSummary, callSentSummary, formatCharCount } from "./trace-format"
import { stabilizePinBandScrollTop } from "./pin-band-scroll"
import {
  TRACE_PIN_OPTS,
  TRACE_STICKY_ROW_H,
  TRACE_STICKY_MAX,
  callIndexForTool,
  computePinnedFromEntries,
  computeTracePinnedScopeIds,
  expandPathForScope,
  layoutOffsetInScroll,
  samePinnedIds,
  syncPinnedInFlow,
  traceScopeDepth,
  type TraceScopeLayout,
} from "./trace-pin"
import { CallOutline } from "./TraceCall"
import { PreambleOutline } from "./TraceContext"
import { IdChip } from "./TraceCopy"
import { TraceExportMenu } from "./TraceExportMenu"
import { PhaseOutline } from "./TracePhase"
import { PinOverlay, type PinRow } from "./TraceScope"
import { WorkOutline } from "./TraceWork"

export function TraceDag({
  dag,
  runId,
  threadId,
  emptySlot,
  onExportMessage,
  onExportError,
}: {
  dag: TraceDag
  runId: string | null
  threadId: string | null
  emptySlot?: ReactNode
  onExportMessage?: (message: string) => void
  onExportError?: (message: string) => void
}) {
  const { soloHidden } = useTilePaint()
  const [search, setSearch] = useState("")
  const [openState, setOpenState] = useState<OpenState>(() => emptyOpen())
  const [pinnedIds, setPinnedIds] = useState<string[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedIdsRef = useRef<string[]>([])
  const pinLayoutCacheRef = useRef(new Map<string, TraceScopeLayout>())
  const pinRafRef = useRef(0)
  const pinSizeRef = useRef({ w: 0, h: 0 })
  const seededRef = useRef(false)
  const searchSeedRef = useRef("")
  const suppressFollowRef = useRef(false)
  const soloHiddenRef = useRef(soloHidden)
  soloHiddenRef.current = soloHidden

  const query = search.trim()
  const { stats } = dag

  function refreshPinStack() {
    const el = scrollRef.current
    if (!el || soloHiddenRef.current) return
    // Skip mid maximize/restore snap — one pass after geometry settles.
    if (el.closest(".workspace-canvas-geometry-snap")) return
    // Cache layouts from the virtual window so headers above the viewport still pin.
    const ids = computeTracePinnedScopeIds(el, pinLayoutCacheRef.current)
    // Band is outside the scrollport — no in-scroll overlay clearance.
    el.style.setProperty("--trace-pin-stack-h", "0px")
    syncPinnedInFlow(el, ids, TRACE_STICKY_ROW_H, { reserveScrollPadding: false })
    if (samePinnedIds(pinnedIdsRef.current, ids)) return
    const prevCount = pinnedIdsRef.current.length
    const layoutCache = pinLayoutCacheRef.current
    const nextScroll = stabilizePinBandScrollTop(
      el.scrollTop,
      prevCount,
      ids,
      (scrollTop) => {
        const entries = [...layoutCache.values()].sort(
          (a, b) => a.top - b.top || a.depth - b.depth,
        )
        return computePinnedFromEntries(
          entries,
          scrollTop,
          TRACE_STICKY_ROW_H,
          TRACE_STICKY_MAX,
          TRACE_PIN_OPTS,
        )
      },
      TRACE_STICKY_ROW_H,
    )
    pinnedIdsRef.current = ids
    setPinnedIds(ids)
    // Only move scrollTop when compensation keeps the same pin set —
    // otherwise SENT/RECEIVED peer handoff oscillates every frame.
    if (nextScroll !== el.scrollTop) el.scrollTop = nextScroll
  }

  /** Coalesce scroll + ResizeObserver into one pin pass per frame (no flicker storms). */
  function schedulePinRefresh() {
    if (soloHiddenRef.current) return
    if (pinRafRef.current) return
    pinRafRef.current = requestAnimationFrame(() => {
      pinRafRef.current = 0
      refreshPinStack()
    })
  }

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
    pinnedIdsRef.current = []
    pinLayoutCacheRef.current.clear()
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

  useEffect(() => {
    // Fold only show/hides a body — refresh pins from mounted scopes.
    // Never clear the layout cache here: wiping it drops unmounted ancestors
    // above the virtual window, pin-band height flickers, and the whole
    // scrollport jumps as if the outline reloaded.
    if (soloHidden) return
    schedulePinRefresh()
  }, [
    soloHidden,
    openState.calls,
    openState.sent,
    openState.received,
    openState.messages,
    openState.tools,
    openState.preamble,
    openState.contextPrompt,
    openState.contextTools,
    openState.phases,
    openState.work,
  ])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    function onScroll() {
      schedulePinRefresh()
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    const ro = new ResizeObserver(() => {
      if (soloHiddenRef.current) return
      const host = scrollRef.current
      if (!host) return
      const w = host.clientWidth
      const h = host.clientHeight
      // Ignore sub-threshold noise; real maximize/restore is a hard size jump.
      if (
        Math.abs(w - pinSizeRef.current.w) < 1 &&
        Math.abs(h - pinSizeRef.current.h) < 1
      ) {
        return
      }
      pinSizeRef.current = { w, h }
      schedulePinRefresh()
    })
    ro.observe(el)
    pinSizeRef.current = { w: el.clientWidth, h: el.clientHeight }
    const raf = requestAnimationFrame(() => {
      if (!soloHiddenRef.current) refreshPinStack()
    })
    return () => {
      el.removeEventListener("scroll", onScroll)
      ro.disconnect()
      cancelAnimationFrame(raf)
      if (pinRafRef.current) cancelAnimationFrame(pinRafRef.current)
      pinRafRef.current = 0
    }
  }, [dag.calls.length, dag.spine.length])

  // After solo-hide ends (or maximize snap clears), one pin pass.
  useEffect(() => {
    if (soloHidden) return
    schedulePinRefresh()
  }, [soloHidden])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || suppressFollowRef.current) return
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
      const workNodes = dag.spine.flatMap((e) => {
        if (e.kind === "work") return [e.work]
        if (e.kind === "phase") {
          return (e.phase.children ?? [])
            .filter((c): c is Extract<typeof c, { kind: "work" }> => c.kind === "work")
            .map((c) => c.work)
        }
        return []
      })
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
          ...dag.calls.flatMap((c) =>
            c.toolBranches.map((t) => callToolOpenKey(c.index, t.id)),
          ),
          ...workNodes.flatMap((w) =>
            w.tools.map((t) => workToolOpenKey(w.id, t.id)),
          ),
        ]),
        phases: new Set(
          dag.spine.filter((e) => e.kind === "phase").map((e) => e.phase.id),
        ),
        work: new Set(workNodes.map((w) => w.id)),
        foldMode: "expanded",
      })
      return
    }
    setOpenState({ ...emptyOpen(), foldMode: "collapsed" })
  }

  const contextSummary = useMemo(() => {
    const bits: string[] = []
    if (dag.preamble.systemPrompt) bits.push("prompt")
    if (dag.preamble.tools.length > 0) {
      bits.push(`${dag.preamble.tools.length} tools`)
    }
    return bits.join(" · ") || "empty"
  }, [dag.preamble])

  /** Spine rows shown in the virtual list (filter hides non-matching work/calls). */
  const spineItems = useMemo((): TraceSpineEntry[] => {
    if (!query || !callHits) return dag.spine
    return dag.spine.filter((entry) => {
      if (entry.kind === "phase") return true
      if (entry.kind === "work") return callHits.has(entry.work.afterCallIndex)
      return callHits.has(entry.callIndex)
    })
  }, [dag.spine, query, callHits])

  function estimateSpineSize(index: number): number {
    const entry = spineItems[index]
    if (!entry) return 48
    if (entry.kind === "phase") {
      return openState.phases.has(entry.phase.id) ? 280 : 40
    }
    if (entry.kind === "work") {
      return openState.work.has(entry.work.id) ? 200 : 40
    }
    return openState.calls.has(entry.callIndex) ? 240 : 48
  }

  function spineItemKey(_index: number, entry: TraceSpineEntry): string {
    if (entry.kind === "phase") return entry.phase.id
    if (entry.kind === "work") return entry.work.id
    return `call:${entry.callIndex}`
  }

  function spineIndexForScope(scopeId: string): number {
    if (scopeId.startsWith("phase-")) {
      return spineItems.findIndex((e) => e.kind === "phase" && e.phase.id === scopeId)
    }
    if (scopeId.startsWith("work-")) {
      const top = spineItems.findIndex((e) => e.kind === "work" && e.work.id === scopeId)
      if (top >= 0) return top
      return spineItems.findIndex(
        (e) =>
          e.kind === "phase" &&
          e.phase.children?.some((c) => c.kind === "work" && c.work.id === scopeId),
      )
    }
    const callMatch =
      /^call:(\d+)$/.exec(scopeId) ??
      /^sent:(\d+)$/.exec(scopeId) ??
      /^received:(\d+)$/.exec(scopeId) ??
      /^message:(\d+):/.exec(scopeId)
    if (callMatch) {
      const callIndex = Number(callMatch[1])
      const top = spineItems.findIndex((e) => e.kind === "call" && e.callIndex === callIndex)
      if (top >= 0) return top
      return spineItems.findIndex(
        (e) =>
          e.kind === "phase" &&
          e.phase.children?.some((c) => c.kind === "call" && c.callIndex === callIndex),
      )
    }
    return -1
  }

  function estimateSpineOffset(index: number): number {
    let top = 0
    for (let i = 0; i < index; i++) top += estimateSpineSize(i)
    return top
  }

  const pinRows = useMemo((): PinRow[] => {
    const rows: PinRow[] = []
    for (const id of pinnedIds) {
      if (id === "context") {
        rows.push({
          id,
          kind: "context",
          depth: traceScopeDepth("context"),
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
          depth: traceScopeDepth("prompt"),
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
          depth: traceScopeDepth("tools"),
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
        const nested = dag.spine.some(
          (e) =>
            e.kind === "phase" &&
            e.phase.children?.some(
              (c) => c.kind === "call" && c.callIndex === index,
            ),
        )
        const usage = call.usage
        rows.push({
          id,
          kind: "call",
          depth: traceScopeDepth("call", nested),
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
        const nested = dag.spine.some(
          (e) =>
            e.kind === "phase" &&
            e.phase.children?.some(
              (c) => c.kind === "call" && c.callIndex === index,
            ),
        )
        rows.push({
          id,
          kind: "sent",
          depth: traceScopeDepth("sent", nested),
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
        const nested = dag.spine.some(
          (e) =>
            e.kind === "phase" &&
            e.phase.children?.some(
              (c) => c.kind === "call" && c.callIndex === index,
            ),
        )
        rows.push({
          id,
          kind: "received",
          depth: traceScopeDepth("received", nested),
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
        const callIndex = Number(msgMatch[1])
        const mi = Number(msgMatch[2])
        const call = dag.calls[callIndex]
        const msg = call?.messages[mi]
        if (!msg) continue
        const nested = dag.spine.some(
          (e) =>
            e.kind === "phase" &&
            e.phase.children?.some(
              (c) => c.kind === "call" && c.callIndex === callIndex,
            ),
        )
        const msgKey = `${callIndex}:m:${mi}`
        rows.push({
          id,
          kind: "message",
          depth: traceScopeDepth("message", nested),
          leading: msg.speaker,
          title: "",
          summary: messagePreview(msg),
          soft: true,
          open: openState.messages.has(msgKey),
        })
        continue
      }
      const phaseEntry = dag.spine.find(
        (e) => e.kind === "phase" && e.phase.id === id,
      )
      if (phaseEntry && phaseEntry.kind === "phase") {
        const phase = phaseEntry.phase
        rows.push({
          id,
          kind: "phase",
          depth: traceScopeDepth("phase"),
          leading: phase.leading ?? phase.title,
          title: phase.leading ? phase.title : "",
          summary: phase.summary,
          soft: false,
          open: openState.phases.has(id),
        })
        continue
      }
      // Resolve work from spine or nested phase children
      let workNode: {
        id: string
        title: string
        summary: string
        nested: boolean
      } | null = null
      for (const entry of dag.spine) {
        if (entry.kind === "work" && entry.work.id === id) {
          workNode = {
            id: entry.work.id,
            title: entry.work.title,
            summary: entry.work.summary,
            nested: false,
          }
          break
        }
        if (entry.kind === "phase") {
          for (const child of entry.phase.children ?? []) {
            if (child.kind === "work" && child.work.id === id) {
              workNode = {
                id: child.work.id,
                title: child.work.title,
                summary: child.work.summary,
                nested: true,
              }
              break
            }
          }
          if (workNode) break
        }
      }
      if (workNode) {
        rows.push({
          id,
          kind: "work",
          depth: traceScopeDepth("work", workNode.nested),
          leading: "Work",
          title: workNode.title !== "Work" ? workNode.title : "",
          summary: workNode.summary,
          soft: false,
          open: openState.work.has(id),
        })
      }
    }
    return rows
  }, [pinnedIds, dag, openState, contextSummary])

  function isScopeOpen(scopeId: string): boolean {
    if (scopeId === "context") return openState.preamble
    if (scopeId === "prompt") return openState.contextPrompt
    if (scopeId === "tools") return openState.contextTools
    const callMatch = /^call:(\d+)$/.exec(scopeId)
    if (callMatch) return openState.calls.has(Number(callMatch[1]))
    const sentMatch = /^sent:(\d+)$/.exec(scopeId)
    if (sentMatch) return openState.sent.has(Number(sentMatch[1]))
    const recvMatch = /^received:(\d+)$/.exec(scopeId)
    if (recvMatch) return openState.received.has(Number(recvMatch[1]))
    const msgMatch = /^message:(\d+):m:(\d+)$/.exec(scopeId)
    if (msgMatch) {
      return openState.messages.has(`${msgMatch[1]}:m:${msgMatch[2]}`)
    }
    if (scopeId.startsWith("phase-")) return openState.phases.has(scopeId)
    if (scopeId.startsWith("work-")) return openState.work.has(scopeId)
    return false
  }

  function onTogglePinnedScope(scopeId: string) {
    const host = scrollRef.current
    const scopeEl = host?.querySelector<HTMLElement>(
      `[data-trace-scope="${CSS.escape(scopeId)}"]`,
    )
    const wasOpen = isScopeOpen(scopeId)
    const scrolledIntoBody = Boolean(
      host &&
        scopeEl &&
        wasOpen &&
        host.scrollTop > offsetInScrollHost(host, scopeEl) + 1,
    )

    if (scopeId === "context") onTogglePreamble()
    else if (scopeId === "prompt") onToggleContextPrompt()
    else if (scopeId === "tools") onToggleContextTools()
    else {
      const callMatch = /^call:(\d+)$/.exec(scopeId)
      if (callMatch) onToggleCall(Number(callMatch[1]))
      else {
        const sentMatch = /^sent:(\d+)$/.exec(scopeId)
        if (sentMatch) onToggleSent(Number(sentMatch[1]))
        else {
          const recvMatch = /^received:(\d+)$/.exec(scopeId)
          if (recvMatch) onToggleReceived(Number(recvMatch[1]))
          else {
            const msgMatch = /^message:(\d+):m:(\d+)$/.exec(scopeId)
            if (msgMatch) onToggleMessage(`${msgMatch[1]}:m:${msgMatch[2]}`)
            else if (scopeId.startsWith("phase-")) onTogglePhase(scopeId)
            else if (scopeId.startsWith("work-")) onToggleWork(scopeId)
          }
        }
      }
    }

    // Collapsing while deep in the body: park on this header (stay in Context,
    // not jump into later Call/Phase content that slid into the hole).
    if (scrolledIntoBody && host && scopeEl) {
      suppressFollowRef.current = true
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!scopeEl.isConnected) return
          parkScrollOnScope(
            host,
            scopeEl,
            TRACE_STICKY_ROW_H,
            computeTracePinnedScopeIds,
            TRACE_PIN_OPTS,
          )
          refreshPinStack()
          suppressFollowRef.current = false
        })
      })
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
      const phases = new Set(prev.phases)
      const work = new Set(prev.work)
      let preamble = prev.preamble
      let contextPrompt = prev.contextPrompt
      let contextTools = prev.contextTools
      if (path.preamble) preamble = true
      if (path.contextPrompt) contextPrompt = true
      if (path.contextTools) contextTools = true
      let callIndex = path.callIndex
      if (path.toolId) {
        const found = callIndexForTool(path.toolId, dag.calls)
        if (found != null) {
          callIndex = found
          tools.add(callToolOpenKey(found, path.toolId))
        }
      }
      if (callIndex != null) {
        calls.add(callIndex)
        if (path.sent) sent.add(callIndex)
        if (path.received) received.add(callIndex)
      }
      if (path.messageKey) messages.add(path.messageKey)
      if (path.phaseId) phases.add(path.phaseId)
      if (path.workId) work.add(path.workId)
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
        phases,
        work,
      }
    })
    suppressFollowRef.current = true
    requestAnimationFrame(() => {
      const host = scrollRef.current
      if (!host) return
      let el = host.querySelector<HTMLElement>(
        `[data-trace-scope="${CSS.escape(scopeId)}"]`,
      )
      if (!el) {
        // Offscreen virtual row — park near estimate so the scope mounts, then settle.
        // Reserved band is outside the scrollport — no stack offset.
        const index = spineIndexForScope(scopeId)
        if (index >= 0) {
          host.scrollTop = Math.max(0, estimateSpineOffset(index) - 2)
        }
        requestAnimationFrame(() => {
          const mounted = scrollRef.current
          if (!mounted) {
            suppressFollowRef.current = false
            return
          }
          el = mounted.querySelector<HTMLElement>(
            `[data-trace-scope="${CSS.escape(scopeId)}"]`,
          )
          if (!el) {
            suppressFollowRef.current = false
            refreshPinStack()
            return
          }
          const top = layoutOffsetInScroll(mounted, el)
          mounted.scrollTop = Math.max(0, top - 2)
          requestAnimationFrame(() => {
            suppressFollowRef.current = false
            refreshPinStack()
          })
        })
        return
      }
      const top = layoutOffsetInScroll(host, el)
      host.scrollTop = Math.max(0, top - 2)
      requestAnimationFrame(() => {
        suppressFollowRef.current = false
        refreshPinStack()
      })
    })
  }

  function onSearchChange(value: string) {
    setSearch(value)
  }

  function renderSpineItem({ item: entry }: { item: TraceSpineEntry }) {
    // Virtual rows — peer rhythm between Context / Plan / Pipeline / Call…
    const gapClass = "trace-spine-gap"
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
        <div className={gapClass}>
          <PhaseOutline
            phase={entry.phase}
            open={openState.phases.has(entry.phase.id)}
            onToggle={() => onTogglePhase(entry.phase.id)}
            nested={nested}
          />
        </div>
      )
    }
    if (entry.kind === "work") {
      return (
        <div className={gapClass}>
          <WorkOutline
            work={entry.work}
            open={openState.work.has(entry.work.id)}
            openState={openState}
            onToggle={() => onToggleWork(entry.work.id)}
            onToggleTool={onToggleTool}
          />
        </div>
      )
    }
    const call = dag.calls[entry.callIndex]
    if (!call) return null
    return (
      <div className={gapClass}>
        <CallOutline
          call={call}
          openState={openState}
          searchHit={callHits?.get(call.index) ?? null}
          onToggleCall={onToggleCall}
          onToggleSent={onToggleSent}
          onToggleReceived={onToggleReceived}
          onToggleMessage={onToggleMessage}
          onToggleTool={onToggleTool}
        />
      </div>
    )
  }

  const searchStatus =
    query && dag.calls.length > 0
      ? `${callHits?.size ?? 0} of ${dag.calls.length} calls`
      : null

  type MetaStat = { value: string; label?: string }
  const metaStats: MetaStat[] = []
  if (stats.callCount > 0) {
    metaStats.push({
      value: String(stats.callCount),
      label: stats.callCount === 1 ? "call" : "calls",
    })
  }
  if (stats.toolRunCount > 0) {
    metaStats.push({
      value: String(stats.toolRunCount),
      label: stats.toolRunCount === 1 ? "tool" : "tools",
    })
  }
  if (stats.phaseCount > 0) {
    metaStats.push({
      value: String(stats.phaseCount),
      label: stats.phaseCount === 1 ? "phase" : "phases",
    })
  }
  if (stats.totalDuration > 0) {
    metaStats.push({ value: formatMs(stats.totalDuration) })
  }
  if (stats.promptTokens > 0 || stats.completionTokens > 0) {
    metaStats.push({ value: fmtTokens(stats.promptTokens), label: "in" })
    metaStats.push({ value: fmtTokens(stats.completionTokens), label: "out" })
  }
  const showMetaBand = metaStats.length > 0 || Boolean(runId || threadId)

  return (
    <div className={`trace-dag ${WIDGET_LOG_SHELL_CLASS}`}>
      <div className={WIDGET_LOG_STACK_CLASS}>
      <WidgetToolbar>
        <WidgetToolbarLeading>{null}</WidgetToolbarLeading>
        <WidgetToolbarSearch
          value={search}
          onChange={onSearchChange}
          placeholder="Filter calls, tools, work…"
          onClear={() => onSearchChange("")}
        />
        <WidgetToolbarTrailing>
          {searchStatus ? (
            <span className="widget-toolbar__count text-text-muted" aria-live="polite">
              {searchStatus}
            </span>
          ) : null}
          <SegmentToggle
            value={openState.foldMode}
            options={[
              { value: "expanded", label: "Expanded" },
              { value: "collapsed", label: "Collapsed" },
            ]}
            onChange={onFoldModeChange}
            ariaLabel="Expand or collapse all trace scopes"
          />
          <TraceExportMenu
            target={
              runId
                ? { kind: "run", runId }
                : threadId
                  ? { kind: "thread", threadId }
                  : null
            }
            onExported={onExportMessage}
            onError={onExportError}
          />
        </WidgetToolbarTrailing>
      </WidgetToolbar>

      {showMetaBand && (
        <div className="widget-review-meta">
          {metaStats.length === 0 ? (
            <span className="widget-review-meta__empty">No agent loop yet</span>
          ) : (
            metaStats.map((stat) => (
              <span key={`${stat.value}:${stat.label ?? ""}`} className="widget-review-meta__stat">
                <span className="widget-review-meta__stat-value">{stat.value}</span>
                {stat.label ? (
                  <span className="widget-review-meta__stat-label">{stat.label}</span>
                ) : null}
              </span>
            ))
          )}
          {runId ? (
            <span className="widget-review-meta__id-group">
              <IdChip label="run" value={runId} tone="meta" />
            </span>
          ) : null}
          {threadId ? (
            <span className="widget-review-meta__id-group">
              <IdChip label="thread" value={threadId} tone="meta" />
            </span>
          ) : null}
        </div>
      )}

      <div className="trace-body min-h-0 flex-1 flex flex-col">
        {emptySlot ? (
          emptySlot
        ) : (
          <div className="trace-scroll-frame">
            <PinOverlay
              rows={pinRows}
              onToggle={onTogglePinnedScope}
              onReveal={onRevealScope}
            />
            <div ref={scrollRef} className="trace-scroll" data-trace-scroll-host>
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
                  <VirtualList
                    items={spineItems}
                    scrollRef={scrollRef}
                    estimateSize={estimateSpineSize}
                    getItemKey={spineItemKey}
                    overscan={TRACE_SPINE_OVERSCAN}
                    adjustScrollOnResize={false}
                    renderItem={renderSpineItem}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
  )
}

