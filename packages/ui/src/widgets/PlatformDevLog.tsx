/**
 * PlatformDevLog — Real-time firehose of every WebSocket event.
 *
 * Shows every single operation flowing through the system:
 * run lifecycle, steps, delegation, usage, debug traces, audit, etc.
 * Designed for platform developers who need full visibility into the event bus.
 */

import { ChevronDown, ChevronRight, Filter, History, Search, Trash2 } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useStore } from "../store"
import type { WsEvent } from "../types"
import { remediationHintForValidationCode } from "../util"

// ── Event category mapping ─────────────────────────────────────

type Category = "run" | "step" | "agent" | "delegation" | "usage" | "debug" | "input" | "api" | "effect" | "memory" | "other"

const CATEGORY_COLOR: Record<Category, string> = {
  run: "#7B6FC7",      // accent purple
  step: "#4ade80",     // green
  agent: "#60a5fa",    // blue
  delegation: "#f97316", // orange
  usage: "#facc15",    // yellow
  debug: "#94a3b8",    // slate
  input: "#f472b6",    // pink
  api: "#22d3ee",      // cyan
  effect: "#a78bfa",   // violet
  memory: "#fb923c",   // amber
  other: "#6b7280",    // gray
}

function categorize(type: string): Category {
  if (type.startsWith("run.")) return "run"
  if (type.startsWith("step.")) return "step"
  if (type.startsWith("agent.")) return "agent"
  if (type.startsWith("delegation.")) return "delegation"
  if (type.startsWith("planner.")) return "debug"
  if (type.startsWith("usage.")) return "usage"
  if (type.startsWith("debug.")) return "debug"
  if (type.startsWith("user_input.") || type === "notification") return "input"
  if (type === "api.request") return "api"
  if (type.startsWith("effect.") || type.startsWith("snapshot.") || type.startsWith("checkpoint.")) return "effect"
  if (type.startsWith("memory.") || type.startsWith("procedural.")) return "memory"
  return "other"
}

// ── Event row ──────────────────────────────────────────────────

function EventRow({ event, index }: { event: WsEvent; index: number }) {
  const [expanded, setExpanded] = useState(false)
  const cat = categorize(event.type)
  const color = CATEGORY_COLOR[cat]
  const ts = event.timestamp.split("T")[1]?.slice(0, 12) ?? event.timestamp

  return (
    <div
      className="border-b"
      style={{ borderColor: "rgba(255,255,255,0.04)" }}
    >
      <button
        className="flex items-center gap-2 w-full px-3 py-1 text-left hover:bg-white/[0.03] transition-colors cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded
          ? <ChevronDown size={12} className="shrink-0 opacity-40" />
          : <ChevronRight size={12} className="shrink-0 opacity-40" />}
        <span className="text-[11px] opacity-30 w-8 shrink-0 text-right font-mono">{index}</span>
        <span className="text-[11px] opacity-40 w-20 shrink-0 font-mono">{ts}</span>
        <span
          className="text-[11px] font-medium px-1.5 py-0.5 rounded shrink-0"
          style={{ background: color + "20", color }}
        >
          {event.type}
        </span>
        <span className="text-[11px] opacity-40 truncate flex-1 font-mono ml-2">
          {summarize(event)}
        </span>
      </button>
      {expanded && (
        <pre
          className="text-[11px] font-mono whitespace-pre-wrap px-10 py-2 overflow-x-auto"
          style={{ color: "rgba(255,255,255,0.6)", background: "rgba(0,0,0,0.2)" }}
        >
          {JSON.stringify(event.data, null, 2)}
        </pre>
      )}
    </div>
  )
}

function summarize(event: WsEvent): string {
  const d = event.data
  if (event.type === "run.completed") {
    const pending = (d["pendingWorkspaceChanges"] as number) ?? 0
    if (pending > 0) return `completed with ${pending} isolated changes awaiting approval`
  }
  if (event.type === "planner.started") return `score=${Number(d["score"] ?? 0).toFixed(2)} ${String(d["reason"] ?? "")}`
  if (event.type === "planner.completed") return `${d["status"]} ${d["completedSteps"]}/${d["totalSteps"]}`
  if (event.type === "planner.pipeline.started") return `attempt ${d["attempt"]}/${d["maxRetries"]}`
  if (event.type === "planner.validation.failed") {
    const diagnostics = Array.isArray(d["diagnostics"]) ? d["diagnostics"] as Array<{ code?: unknown }> : []
    const first = diagnostics[0]
    const code = typeof first?.code === "string" ? first.code : "validation_error"
    return `validation failed (${diagnostics.length} diagnostics, first=${code})`
  }
  if (event.type === "planner.validation.remediated") {
    const diagnostics = Array.isArray(d["diagnostics"]) ? d["diagnostics"] as Array<{ code?: unknown }> : []
    const first = diagnostics[0]
    const code = typeof first?.code === "string" ? first.code : "none"
    return `validation auto-remediated (${diagnostics.length} diagnostics, first=${code})`
  }
  if (event.type === "planner.step.started") return `${d["stepName"]} (${d["stepType"]})`
  if (event.type === "planner.step.completed") {
    const status = String(d["status"] ?? "unknown")
    const code = typeof d["validationCode"] === "string" ? d["validationCode"] : undefined
    const acceptance = typeof d["acceptanceState"] === "string" ? ` · ${d["acceptanceState"]}` : ""
    if (status === "completed") return `${d["stepName"]} ${status}${acceptance} ${d["durationMs"]}ms`
    const hint = remediationHintForValidationCode(code)
    return `${d["stepName"]} ${status}${acceptance}${code ? ` [${code}]` : ""} — ${hint}`
  }
  if (event.type === "planner.repair.plan") {
    const rerunOrder = Array.isArray(d["rerunOrder"]) ? (d["rerunOrder"] as unknown[]).join(" → ") : ""
    return `repair plan attempt ${d["attempt"]}${rerunOrder ? ` rerun=${rerunOrder}` : ""}`
  }
  if (event.type === "planner.runtime.compiled") {
    const executionSteps = Array.isArray(d["executionSteps"]) ? d["executionSteps"].length : 0
    const ownershipArtifacts = Array.isArray(d["ownershipArtifacts"]) ? d["ownershipArtifacts"].length : 0
    const runtimeEntities = Array.isArray(d["runtimeEntities"]) ? d["runtimeEntities"].length : 0
    return `runtime compiled steps=${executionSteps} artifacts=${ownershipArtifacts} entities=${runtimeEntities}`
  }
  if (event.type === "planner.delegation.started") return `child ${d["stepName"]} depth=${d["depth"]}`
  if (event.type === "planner.delegation.iteration") return `${d["stepName"]} iter ${d["iteration"]}/${d["maxIterations"]}`
  if (event.type === "planner.delegation.ended") return `child ${d["stepName"]} ${d["status"]}`
  if (event.type === "debug.trace") {
    const entry = d["entry"] as Record<string, unknown> | undefined
    const kind = entry?.["kind"]
    if (kind === "planner-step-end") {
      const status = String(entry?.["status"] ?? "unknown")
      const code = typeof entry?.["validationCode"] === "string" ? entry["validationCode"] : undefined
      const acceptance = typeof entry?.["acceptanceState"] === "string" ? ` · ${String(entry["acceptanceState"])}` : ""
      if (status === "completed") {
        return `${String(entry?.["stepName"] ?? "step")} ${status}${acceptance} ${entry?.["durationMs"] ?? "?"}ms`
      }
      return `${String(entry?.["stepName"] ?? "step")} ${status}${acceptance}${code ? ` [${code}]` : ""} — ${remediationHintForValidationCode(code)}`
    }
    if (kind === "planner-repair-plan") {
      const rerunOrder = Array.isArray(entry?.["rerunOrder"]) ? (entry["rerunOrder"] as unknown[]).join(" → ") : ""
      return `repair plan attempt ${entry?.["attempt"] ?? "?"}${rerunOrder ? ` rerun=${rerunOrder}` : ""}`
    }
    if (kind === "planner-runtime-compiled") {
      const executionSteps = Array.isArray(entry?.["executionSteps"]) ? entry["executionSteps"].length : 0
      const ownershipArtifacts = Array.isArray(entry?.["ownershipArtifacts"]) ? entry["ownershipArtifacts"].length : 0
      const runtimeEntities = Array.isArray(entry?.["runtimeEntities"]) ? entry["runtimeEntities"].length : 0
      return `runtime compiled steps=${executionSteps} artifacts=${ownershipArtifacts} entities=${runtimeEntities}`
    }
    if (kind === "workspace_diff") {
      const diff = entry?.["diff"] as { added?: unknown[]; modified?: unknown[]; deleted?: unknown[] } | undefined
      const added = diff?.added?.length ?? 0
      const modified = diff?.modified?.length ?? 0
      const deleted = diff?.deleted?.length ?? 0
      return `workspace diff pending (+${added} ~${modified} -${deleted})`
    }
    if (kind === "workspace_diff_applied") {
      const summary = entry?.["summary"] as { added?: number; modified?: number; deleted?: number } | undefined
      const added = summary?.added ?? 0
      const modified = summary?.modified ?? 0
      const deleted = summary?.deleted ?? 0
      return `workspace diff applied (+${added} ~${modified} -${deleted})`
    }
  }
  // API request
  if (event.type === "api.request") return `${d["method"]} ${d["url"]} → ${d["status_code"]} (${d["duration_ms"]}ms)`
  // Effect tracking
  if (event.type === "effect.recorded") return `${d["kind"]} ${d["tool"]}: ${String(d["target"]).split("/").pop()}`
  if (event.type === "snapshot.captured") return `${String(d["filePath"]).split("/").pop()} (${d["hash"] ? String(d["hash"]).slice(0, 8) : "new"})`
  if (event.type === "checkpoint.saved") return `run ${String(d["runId"]).slice(0, 8)} iter=${d["iteration"]} step=${d["stepCounter"]}`
  // Memory
  if (event.type === "memory.ingested") return `${d["tier"]}/${d["role"]} ${d["contentPreview"] ?? ""}`
  if (event.type === "procedural.stored") return `${d["trigger"]} (${d["toolCount"]} tools)`
  // Standard events
  if (d["goal"]) return String(d["goal"]).slice(0, 80)
  if (d["action"]) return `${d["action"]}(${d["name"] ?? ""})`
  if (d["answer"]) return String(d["answer"]).slice(0, 80)
  if (d["error"]) return String(d["error"]).slice(0, 80)
  if (d["content"]) return String(d["content"]).slice(0, 80)
  if (d["question"]) return String(d["question"]).slice(0, 80)
  if (d["totalTokens"]) return `${d["totalTokens"]} tokens, ${d["llmCalls"] ?? "?"} calls`
  if (d["entry"]) {
    const e = d["entry"] as Record<string, unknown>
    return `${e["kind"] ?? "trace"}`
  }
  const keys = Object.keys(d)
  return keys.length > 0 ? keys.join(", ") : ""
}

// ── Main component ─────────────────────────────────────────────

export function PlatformDevLog() {
  const liveEvents = useStore((s) => s.wsEventLog)
  const clearLog = useStore((s) => s.clearWsEventLog)
  const [search, setSearch] = useState("")
  const [filterOpen, setFilterOpen] = useState(false)
  const [hiddenCategories, setHiddenCategories] = useState<Set<Category>>(new Set())
  const [autoScroll, setAutoScroll] = useState(true)
  const [historyEvents, setHistoryEvents] = useState<WsEvent[]>([])
  const [historyMode, setHistoryMode] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const prevCount = useRef(liveEvents.length)

  const events = historyMode
    ? [...historyEvents, ...liveEvents]
    : liveEvents

  const loadHistory = useCallback(async (before?: string) => {
    setLoadingHistory(true)
    try {
      const params = new URLSearchParams({ limit: "500" })
      if (before) params.set("before", before)
      const res = await fetch(`/api/events?${params}`)
      const data = await res.json() as {
        events: Array<{ type: string; data: Record<string, unknown>; timestamp: string }>
        hasMore: boolean
      }
      const mapped: WsEvent[] = data.events
        .reverse() // API returns desc, we want chronological
        .map((e) => ({ type: e.type, data: e.data, timestamp: e.timestamp }))

      if (before) {
        // Loading more — prepend to existing
        setHistoryEvents((prev) => [...mapped, ...prev])
      } else {
        setHistoryEvents(mapped)
      }
      setHistoryMode(true)
      setHasMore(data.hasMore)
    } catch {
      // fail silently
    } finally {
      setLoadingHistory(false)
    }
  }, [])

  const loadMore = useCallback(() => {
    if (historyEvents.length > 0) {
      loadHistory(historyEvents[0]!.timestamp)
    }
  }, [historyEvents, loadHistory])

  const exitHistory = useCallback(() => {
    setHistoryMode(false)
    setHistoryEvents([])
    setHasMore(false)
  }, [])

  const toggleCategory = useCallback((cat: Category) => {
    setHiddenCategories((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }, [])

  const filtered = useMemo(() => {
    let result = events
    if (hiddenCategories.size > 0) {
      result = result.filter((e) => !hiddenCategories.has(categorize(e.type)))
    }
    if (search) {
      const q = search.toLowerCase()
      result = result.filter(
        (e) =>
          e.type.toLowerCase().includes(q) ||
          JSON.stringify(e.data).toLowerCase().includes(q),
      )
    }
    return result
  }, [events, hiddenCategories, search])

  // Auto-scroll to bottom when new events come in
  useEffect(() => {
    if (autoScroll && liveEvents.length > prevCount.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
    prevCount.current = liveEvents.length
  }, [liveEvents.length, autoScroll])

  const categories: Category[] = ["run", "step", "agent", "delegation", "usage", "api", "effect", "memory", "debug", "input", "other"]

  return (
    <div className="h-full flex flex-col" style={{ background: "#09090b", color: "#e4e4e7" }}>
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 shrink-0 text-[13px]"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
      >
        <span className="font-medium opacity-70">Platform Dev Log</span>
        <span className="text-[11px] opacity-30">{filtered.length}/{events.length} events</span>
        <div className="flex-1" />

        {/* Search */}
        <div className="flex items-center gap-1 rounded px-1.5 py-0.5" style={{ background: "rgba(255,255,255,0.05)" }}>
          <Search size={12} className="opacity-40" />
          <input
            type="text"
            className="bg-transparent outline-none text-[12px] w-32"
            style={{ color: "#e4e4e7" }}
            placeholder="filter events..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Category filter toggle */}
        <button
          className="p-1 rounded hover:bg-white/[0.06] transition-colors cursor-pointer"
          style={{ color: filterOpen || hiddenCategories.size > 0 ? "#7B6FC7" : "rgba(255,255,255,0.4)" }}
          onClick={() => setFilterOpen((v) => !v)}
          title="Filter by category"
        >
          <Filter size={14} />
        </button>

        {/* History toggle */}
        <button
          className="p-1 rounded hover:bg-white/[0.06] transition-colors cursor-pointer"
          style={{ color: historyMode ? "#22d3ee" : "rgba(255,255,255,0.4)" }}
          onClick={() => historyMode ? exitHistory() : loadHistory()}
          title={historyMode ? "Exit history (live only)" : "Load event history"}
          disabled={loadingHistory}
        >
          <History size={14} />
        </button>

        {/* Auto-scroll toggle */}
        <button
          className="text-[11px] px-1.5 py-0.5 rounded cursor-pointer"
          style={{
            background: autoScroll ? "#7B6FC720" : "transparent",
            color: autoScroll ? "#7B6FC7" : "rgba(255,255,255,0.3)",
          }}
          onClick={() => setAutoScroll((v) => !v)}
          title="Auto-scroll to bottom"
        >
          AUTO
        </button>

        {/* Clear */}
        <button
          className="p-1 rounded hover:bg-white/[0.06] transition-colors cursor-pointer"
          style={{ color: "rgba(255,255,255,0.4)" }}
          onClick={clearLog}
          title="Clear event log"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {/* Category filter bar */}
      {filterOpen && (
        <div
          className="flex items-center gap-1 px-3 py-1 shrink-0 flex-wrap"
          style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
        >
          {categories.map((cat) => {
            const active = !hiddenCategories.has(cat)
            const color = CATEGORY_COLOR[cat]
            return (
              <button
                key={cat}
                className="text-[11px] px-2 py-0.5 rounded cursor-pointer transition-colors"
                style={{
                  background: active ? color + "20" : "transparent",
                  color: active ? color : "rgba(255,255,255,0.2)",
                  border: `1px solid ${active ? color + "40" : "rgba(255,255,255,0.06)"}`,
                }}
                onClick={() => toggleCategory(cat)}
              >
                {cat}
              </button>
            )
          })}
        </div>
      )}

      {/* Event list */}
      <div ref={listRef} className="flex-1 overflow-y-auto min-h-0">
        {loadingHistory && (
          <div className="text-center text-[11px] py-2 opacity-40">Loading history...</div>
        )}
        {historyMode && hasMore && !loadingHistory && (
          <button
            className="w-full text-center text-[11px] py-1.5 cursor-pointer hover:bg-white/[0.04] transition-colors"
            style={{ color: "#22d3ee", borderBottom: "1px solid rgba(255,255,255,0.04)" }}
            onClick={loadMore}
          >
            Load older events...
          </button>
        )}
        {historyMode && !loadingHistory && historyEvents.length > 0 && (
          <div
            className="text-center text-[11px] py-0.5 opacity-30"
            style={{ borderBottom: "1px solid rgba(34,211,238,0.15)" }}
          >
            {historyEvents.length} historical + {liveEvents.length} live
          </div>
        )}
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-[13px] opacity-30">
            {events.length === 0 ? "Waiting for events..." : "No events match filters"}
          </div>
        ) : (
          filtered.map((event, i) => (
            <EventRow key={`${event.timestamp}-${event.type}-${i}`} event={event} index={i} />
          ))
        )}
      </div>
    </div>
  )
}
