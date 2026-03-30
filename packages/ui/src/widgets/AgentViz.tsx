/**
 * AgentViz — live interactive force-directed graph of agents and tools.
 *
 * Uses react-force-graph-2d (d3-force + canvas) for:
 * - Draggable nodes (agents + tools)
 * - Pan and zoom
 * - Animated directional particles on tool calls
 * - Multi-agent aware: loads all agent definitions, shows their tool connections
 *
 * Layout: graph on the right, activity feed on the left.
 */

import { ChevronDown, Maximize2, Minus, Plus } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ForceGraphMethods, LinkObject, NodeObject } from "react-force-graph-2d"
import ForceGraph2D from "react-force-graph-2d"
import { api } from "../api"
import { useStore } from "../store"
import type { AgentDefinition, TraceEntry } from "../types"

// ── Palette ──────────────────────────────────────────────────────

const C = {
  deep:     "#342F57",
  mid:      "#584770",
  plum:     "#825776",
  accent:   "#7B6FC7",
  rose:     "#D17877",
  peach:    "#F49D6C",
  coral:    "#EA6248",
  success:  "#5db078",
  text:     "#f4f4f5",
  muted:    "#a1a1aa",
  surface:  "#121214",
  elevated: "#1c1c1f",
  base:     "#09090b",
}

// Agent colors — distinguish up to 8 agents visually
const AGENT_COLORS = [C.accent, C.rose, C.peach, C.coral, C.success, C.plum, "#6CB4EE", "#B8A9C9"]

// ── Tool label mapping ───────────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
  read_file: "Read",
  write_file: "Write",
  list_directory: "List",
  run_command: "Shell",
  fetch_url: "Fetch",
  think: "Think",
}

function toolLabel(id: string): string {
  return TOOL_LABELS[id] ?? id.slice(0, 8)
}

// ── Node / Link types ────────────────────────────────────────────

interface VizNode {
  id: string
  type: "agent" | "tool"
  label: string
  color: string
  agentId?: string
  toolId?: string
  val?: number
  x?: number
  y?: number
}

interface VizLink {
  source: string
  target: string
  agentId: string
  color: string
}

// ── Component ────────────────────────────────────────────────────

type VizMode = "live" | "reflect"

export function AgentViz() {
  const liveTrace = useStore((s) => s.trace)
  const runs = useStore((s) => s.runs)
  const activeRunId = useStore((s) => s.activeRunId)

  const containerRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<ForceGraphMethods<NodeObject<VizNode>, LinkObject<VizNode, VizLink>>>(undefined)
  const [size, setSize] = useState({ w: 600, h: 400 })
  const [agents, setAgents] = useState<AgentDefinition[]>([])
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const prevTraceLen = useRef(0)
  const feedRef = useRef<HTMLDivElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [zoomLevel, setZoomLevel] = useState(100)
  // Zoom calibration: raw zoom of ~4.55 = displayed 100%
  const zoomBaseRef = useRef(1)

  // Mode: live (real-time) or reflect (review past run)
  const [mode, setMode] = useState<VizMode>("live")
  const [reflectRunId, setReflectRunId] = useState<string | null>(null)
  const [reflectTrace, setReflectTrace] = useState<TraceEntry[]>([])
  const [loadingReflect, setLoadingReflect] = useState(false)

  // Pulsing animation for status dot — declared here, used after isRunning is derived
  const [pulse, setPulse] = useState(true)

  // Close picker on outside click
  useEffect(() => {
    if (!pickerOpen) return
    function handleClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [pickerOpen])

  // Active trace depends on mode
  const trace = mode === "live" ? liveTrace : reflectTrace

  // Feed width for the left panel — generous so headers don't clip
  const feedW = Math.max(200, Math.min(360, size.w * 0.45))

  // Track resize
  useEffect(() => {
    if (!containerRef.current) return
    const obs = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      if (width > 0 && height > 0) setSize({ w: width, h: height })
    })
    obs.observe(containerRef.current)
    return () => obs.disconnect()
  }, [])

  // Load agents
  useEffect(() => {
    api.listAgents().then(setAgents).catch(() => {})
  }, [])

  // Refresh agents when runs change (new agent might have been created)
  // Stabilise: only update state if the list actually changed
  useEffect(() => {
    api.listAgents().then((fresh) => {
      setAgents((prev) => {
        const prevIds = prev.map((a) => a.id + a.tools.join()).join("|")
        const freshIds = fresh.map((a) => a.id + a.tools.join()).join("|")
        return prevIds === freshIds ? prev : fresh
      })
    }).catch(() => {})
  }, [runs.length])

  // Load trace for reflect mode
  useEffect(() => {
    if (mode !== "reflect" || !reflectRunId) return
    setLoadingReflect(true)
    api.getRunTrace(reflectRunId)
      .then((entries) => setReflectTrace(entries as TraceEntry[]))
      .catch(() => setReflectTrace([]))
      .finally(() => setLoadingReflect(false))
  }, [mode, reflectRunId])

  // When switching to reflect, auto-select the most recent completed run
  useEffect(() => {
    if (mode === "reflect" && !reflectRunId) {
      const completed = runs.filter((r) => r.status === "completed" || r.status === "failed")
      if (completed.length > 0) setReflectRunId(completed[0].id)
    }
  }, [mode, reflectRunId, runs])

  // Auto-switch to live when a new run starts
  useEffect(() => {
    if (activeRunId && mode === "reflect") {
      const run = runs.find((r) => r.id === activeRunId)
      if (run?.status === "running") {
        setMode("live")
      }
    }
  }, [activeRunId, runs, mode])

  // Derive state
  const activeRun = runs.find((r) => r.id === activeRunId)
  const reflectRun = reflectRunId ? runs.find((r) => r.id === reflectRunId) : null
  const displayRun = mode === "live" ? activeRun : reflectRun
  const isRunning = mode === "live" && activeRun?.status === "running"

  // The agent that owns the current run (works in both live and reflect)
  const activeAgentId = displayRun?.agentId ?? null
  // Whether we have a run context at all (live with trace data, or reflect with loaded trace)
  const hasRunContext = (mode === "live" && activeAgentId != null && trace.length > 0) || (mode === "reflect" && reflectRunId != null && trace.length > 0)

  // Pulse the status dot while running
  useEffect(() => {
    if (!isRunning) return
    const id = setInterval(() => setPulse((p) => !p), 800)
    return () => clearInterval(id)
  }, [isRunning])

  // Build tool stats from active trace
  const toolStats = useMemo(() => {
    const stats = new Map<string, { calls: number; errors: number; lastStatus: "idle" | "running" | "done" | "error" }>()
    let currentTool: string | null = null
    for (const entry of trace) {
      if (entry.kind === "tool-call") {
        currentTool = entry.tool
        const s = stats.get(entry.tool) ?? { calls: 0, errors: 0, lastStatus: "idle" as const }
        s.calls++
        s.lastStatus = "running"
        stats.set(entry.tool, s)
      } else if (entry.kind === "tool-result" && currentTool) {
        const s = stats.get(currentTool)
        if (s) s.lastStatus = "done"
        currentTool = null
      } else if (entry.kind === "tool-error" && currentTool) {
        const s = stats.get(currentTool)
        if (s) { s.errors++; s.lastStatus = "error" }
        currentTool = null
      }
    }
    return stats
  }, [trace])

  // Current iteration
  const currentIteration = useMemo(() => {
    for (let i = trace.length - 1; i >= 0; i--) {
      if (trace[i].kind === "iteration") return (trace[i] as { kind: "iteration"; current: number; max: number }).current
    }
    return 0
  }, [trace])

  // Set of tool IDs actually used in the current trace
  const involvedToolIds = useMemo(() => {
    const ids = new Set<string>()
    for (const entry of trace) {
      if (entry.kind === "tool-call") ids.add(entry.tool)
    }
    return ids
  }, [trace])

  // Build graph data from agents — ONLY recompute when agent structure changes
  // Visual states (colors, running, stats) are handled in paintNode
  const graphData = useMemo(() => {
    const nodes: VizNode[] = []
    const links: VizLink[] = []
    const toolNodeIds = new Set<string>()

    agents.forEach((agent, idx) => {
      const agentColor = AGENT_COLORS[idx % AGENT_COLORS.length]
      const agentNodeId = `agent:${agent.id}`

      // Place agents on the left side, vertically spread
      nodes.push({
        id: agentNodeId,
        type: "agent",
        label: agent.name,
        color: agentColor,
        agentId: agent.id,
        val: 5,
        x: -60,
        y: (idx - (agents.length - 1) / 2) * 50,
      })

      for (const toolId of agent.tools) {
        const toolNodeId = `tool:${toolId}`
        if (!toolNodeIds.has(toolNodeId)) {
          const toolIdx = toolNodeIds.size
          toolNodeIds.add(toolNodeId)
          // Place tools on the right side, vertically spread
          nodes.push({
            id: toolNodeId,
            type: "tool",
            label: toolLabel(toolId),
            color: C.mid,
            toolId,
            val: 3,
            x: 60,
            y: (toolIdx - 2.5) * 40,
          })
        }

        links.push({
          source: agentNodeId,
          target: `tool:${toolId}`,
          agentId: agent.id,
          color: agentColor,
        })
      }
    })

    return { nodes, links }
  }, [agents])

  // Emit particles when new tool calls arrive (live mode only)
  useEffect(() => {
    if (mode !== "live") return
    if (liveTrace.length <= prevTraceLen.current) {
      prevTraceLen.current = liveTrace.length
      return
    }
    const newEntries = liveTrace.slice(prevTraceLen.current)
    prevTraceLen.current = liveTrace.length

    const fg = graphRef.current
    if (!fg) return

    for (const entry of newEntries) {
      if (entry.kind === "tool-call") {
        const agentId = activeRun?.agentId
        if (!agentId) continue
        const link = graphData.links.find(
          (l) => l.agentId === agentId && (typeof l.target === "string" ? l.target : (l.target as VizNode).id) === `tool:${entry.tool}`
        )
        if (link) {
          try { fg.emitParticle(link as LinkObject<VizNode, VizLink>) } catch { /* ok */ }
        }
      }
    }
  }, [liveTrace, activeRun, graphData.links, mode])

  // Configure d3 forces — tighter layout, agents left / tools right
  useEffect(() => {
    const fg = graphRef.current
    if (!fg) return
    // Moderate link distance — keep it concentrated
    fg.d3Force("link")?.distance(55).strength(0.2)
    // Gentle charge repulsion
    fg.d3Force("charge")?.strength(-120).distanceMax(200)
    // Custom X-position force: agents drift left, tools drift right
    // d3-force calls each force as force(alpha), so it must be a function
    let forceNodes: NodeObject<VizNode>[] = []
    const xBias = (alpha: number) => {
      for (const node of forceNodes) {
        if (node.fx != null) continue // don't fight pinned nodes
        const target = node.type === "agent" ? -60 : 60
        node.vx = (node.vx ?? 0) + (target - (node.x ?? 0)) * 0.02 * alpha
      }
    }
    xBias.initialize = (nodes: NodeObject<VizNode>[]) => { forceNodes = nodes }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fg.d3Force("xBias", xBias as any)
  }, [graphData])

  // Fit to view on data change — calibrate zoom so initial fit = 100%
  // Offset the center rightward so the diagram sits in the visible area
  // to the right of the log overlay panel.
  useEffect(() => {
    const fg = graphRef.current
    if (!fg || agents.length === 0) return
    const timer = setTimeout(() => {
      fg.zoomToFit(400, 60)
      setTimeout(() => {
        const z = fg.zoom()
        const target = z * 0.65
        zoomBaseRef.current = target // this is our "100%"
        fg.zoom(target, 300)
        // Shift center rightward to account for the log panel
        // Compute centroid from nodes, then offset by half the panel width in graph coords
        const nodes = graphData.nodes
        let cx = 0, cy = 0
        for (const n of nodes) {
          cx += (n as NodeObject<VizNode>).x ?? 0
          cy += (n as NodeObject<VizNode>).y ?? 0
        }
        const centroidX = nodes.length > 0 ? cx / nodes.length : 0
        const centroidY = nodes.length > 0 ? cy / nodes.length : 0
        const panelOffset = feedW / 2 / target
        fg.centerAt(centroidX - panelOffset, centroidY, 400)
        setZoomLevel(100)
      }, 450)
    }, 300)
    return () => clearTimeout(timer)
  }, [agents.length, feedW])

  // Track zoom changes — display relative to calibrated base
  // Deferred to avoid setState during ForceGraph2D render cycle
  const handleZoom = useCallback((transform: { k: number }) => {
    queueMicrotask(() => {
      const base = zoomBaseRef.current
      setZoomLevel(base > 0 ? Math.round((transform.k / base) * 100) : 100)
    })
  }, [])

  // Custom node renderer
  const paintNode = useCallback((node: NodeObject<VizNode>, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const x = node.x ?? 0
    const y = node.y ?? 0
    const r = node.type === "agent" ? 10 : 7

    if (node.type === "agent") {
      const isActiveAgent = node.agentId === activeAgentId
      const isLiveRunning = isActiveAgent && isRunning
      // Dim agents that are not involved in the current run
      const dimmed = hasRunContext && !isActiveAgent

      // Subtle glow for the active agent (live running OR reflect)
      if (isActiveAgent && hasRunContext) {
        ctx.fillStyle = node.color + (isLiveRunning ? "18" : "0c")
        ctx.beginPath()
        ctx.arc(x, y, r * 1.5, 0, Math.PI * 2)
        ctx.fill()
      }

      // Core circle
      ctx.fillStyle = dimmed ? C.base + "aa" : C.deep + "cc"
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()

      // Ring: slightly brighter for active, muted for others, faint for dimmed
      ctx.strokeStyle = dimmed ? C.mid + "30" : node.color + (isActiveAgent && hasRunContext ? "aa" : "60")
      ctx.lineWidth = isActiveAgent && hasRunContext ? 1.2 : dimmed ? 0.5 : 0.8
      ctx.stroke()

      // Label
      ctx.font = `${Math.max(4, 13 / globalScale)}px sans-serif`
      ctx.fillStyle = dimmed ? C.muted + "40" : isActiveAgent && hasRunContext ? C.text : C.text + "bb"
      ctx.textAlign = "center"
      ctx.textBaseline = "top"
      ctx.fillText(node.label, x, y + r + 3)
    } else {
      // Tool node
      const stats = toolStats.get(node.toolId ?? "")
      const active = stats?.lastStatus === "running"
      const wasUsed = involvedToolIds.has(node.toolId ?? "")
      // Dim tools not used in the current run
      const dimmed = hasRunContext && !wasUsed
      const toolColor = active ? C.accent
        : stats?.lastStatus === "error" ? C.coral
        : stats?.lastStatus === "done" ? C.success
        : C.mid

      ctx.fillStyle = dimmed ? C.base + "88" : C.elevated
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()

      ctx.strokeStyle = dimmed ? C.mid + "20" : toolColor + (active ? "cc" : wasUsed ? "88" : "60")
      ctx.lineWidth = active ? 1.4 : dimmed ? 0.5 : 0.8
      ctx.stroke()

      // Call count centered inside the circle (replaces inner dot)
      if (stats && stats.calls > 0) {
        ctx.font = `${Math.max(4, 12 / globalScale)}px sans-serif`
        ctx.fillStyle = dimmed ? toolColor + "30" : toolColor
        ctx.textAlign = "center"
        ctx.textBaseline = "middle"
        ctx.fillText(stats.calls > 99 ? "99+" : String(stats.calls), x, y + 0.5)
      } else {
        // No calls yet — subtle inner dot
        ctx.fillStyle = dimmed ? toolColor + "10" : toolColor + "40"
        ctx.beginPath()
        ctx.arc(x, y, r * 0.2, 0, Math.PI * 2)
        ctx.fill()
      }

      ctx.font = `${Math.max(4, 12 / globalScale)}px sans-serif`
      ctx.fillStyle = dimmed ? C.muted + "30" : stats && stats.calls > 0 ? C.text : C.muted
      ctx.textAlign = "center"
      ctx.textBaseline = "top"
      ctx.fillText(node.label, x, y + r + 2)
    }
  }, [activeAgentId, hasRunContext, isRunning, toolStats, involvedToolIds])

  // Node click area
  const paintNodeArea = useCallback((node: NodeObject<VizNode>, color: string, ctx: CanvasRenderingContext2D) => {
    const r = node.type === "agent" ? 12 : 9
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, Math.PI * 2)
    ctx.fill()
  }, [])

  // Handle node click
  const handleNodeClick = useCallback((node: NodeObject<VizNode>) => {
    setSelectedNode((prev) => prev === node.id ? null : (node.id as string))
  }, [])

  // Custom link renderer — smooth curved lines, dim non-active agent links
  const paintLink = useCallback((link: LinkObject<VizNode, VizLink>, ctx: CanvasRenderingContext2D) => {
    const vLink = link as unknown as VizLink
    const src = link.source as NodeObject<VizNode>
    const tgt = link.target as NodeObject<VizNode>
    if (!src || !tgt || src.x == null || tgt.x == null) return

    const isActiveLink = vLink.agentId === activeAgentId
    const toolUsed = involvedToolIds.has(tgt.id?.toString().replace("tool:", "") ?? "")
    // Only highlight links from the active agent to tools that were actually used
    const highlight = hasRunContext && isActiveLink && toolUsed
    const dimmed = hasRunContext && !isActiveLink

    // Opacity: highlighted links visible, dimmed nearly invisible
    const alpha = highlight ? "44" : dimmed ? "08" : "1a"

    // Curve the link slightly for visual smoothness
    const mx = (src.x + tgt.x) / 2
    const my = (src.y! + tgt.y!) / 2
    // Offset control point perpendicular to the link direction
    const dx = tgt.x - src.x
    const dy = tgt.y! - src.y!
    const len = Math.sqrt(dx * dx + dy * dy) || 1
    const offset = len * 0.08
    const cx = mx + (-dy / len) * offset
    const cy = my + (dx / len) * offset

    ctx.beginPath()
    ctx.moveTo(src.x, src.y!)
    ctx.quadraticCurveTo(cx, cy, tgt.x, tgt.y!)
    ctx.strokeStyle = vLink.color + alpha
    ctx.lineWidth = highlight ? 1.2 : 0.5
    ctx.stroke()
  }, [activeAgentId, hasRunContext, involvedToolIds])

  // Pin node after drag so it stays where the user put it
  const handleNodeDragEnd = useCallback((node: NodeObject<VizNode>) => {
    node.fx = node.x
    node.fy = node.y
  }, [])

  // Build detail for selected node
  const detailInfo = useMemo((): { title: string; lines: Array<{ label: string; value: string }> } | null => {
    if (!selectedNode) return null
    if (selectedNode.startsWith("agent:")) {
      const agentId = selectedNode.slice(6)
      const agent = agents.find((a) => a.id === agentId)
      if (!agent) return null
      const agentRuns = runs.filter((r) => r.agentId === agentId)
      const completed = agentRuns.filter((r) => r.status === "completed").length
      const failed = agentRuns.filter((r) => r.status === "failed").length
      return {
        title: agent.name,
        lines: [
          { label: "Tools", value: String(agent.tools.length) },
          { label: "Total runs", value: String(agentRuns.length) },
          { label: "Completed", value: String(completed) },
          { label: "Failed", value: String(failed) },
          ...(displayRun?.agentId === agentId ? [
            { label: "Status", value: displayRun.status },
            { label: "Iteration", value: String(currentIteration) },
          ] : []),
        ],
      }
    }
    if (selectedNode.startsWith("tool:")) {
      const toolId = selectedNode.slice(5)
      const stats = toolStats.get(toolId)
      return {
        title: toolLabel(toolId),
        lines: stats ? [
          { label: "Calls", value: String(stats.calls) },
          { label: "Errors", value: String(stats.errors) },
          { label: "Status", value: stats.lastStatus },
        ] : [
          { label: "Status", value: "No activity" },
        ],
      }
    }
    return null
  }, [selectedNode, agents, runs, displayRun, currentIteration, toolStats])

  // Activity feed
  const recentActivity = useMemo(() => {
    const items: Array<{ text: string; color: string; time: number }> = []
    for (let i = trace.length - 1; i >= 0 && items.length < 80; i--) {
      const e = trace[i]
      if (e.kind === "tool-call") {
        items.push({ text: `${toolLabel(e.tool)}(${e.argsSummary || "..."})`, color: C.accent, time: i })
      } else if (e.kind === "tool-result") {
        const preview = e.text.length > 80 ? e.text.slice(0, 77) + "..." : e.text
        items.push({ text: preview, color: C.success, time: i })
      } else if (e.kind === "tool-error") {
        items.push({ text: e.text.slice(0, 80), color: C.coral, time: i })
      } else if (e.kind === "thinking") {
        items.push({ text: e.text.slice(0, 70) + "...", color: C.peach, time: i })
      } else if (e.kind === "answer") {
        items.push({ text: e.text.slice(0, 80), color: C.success, time: i })
      } else if (e.kind === "iteration") {
        items.push({ text: `iter ${e.current}/${e.max}`, color: C.mid, time: i })
      }
    }
    return items.reverse()
  }, [trace])

  // Completed runs for reflect picker
  const completedRuns = useMemo(() =>
    runs.filter((r) => r.status === "completed" || r.status === "failed").slice(0, 20),
  [runs])

  // Auto-scroll feed to bottom on new entries
  useEffect(() => {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [recentActivity.length])

  // Graph dimensions — full width, graph renders under the log overlay
  const graphW = size.w
  const graphH = size.h

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden select-none" style={{ background: C.base }}>

      {/* Graph layer — full width behind everything */}
      <div className="absolute inset-0" style={{ cursor: "grab" }}>
        <ForceGraph2D
          ref={graphRef}
          graphData={graphData}
          width={graphW}
          height={graphH}
          backgroundColor={"transparent"}
          nodeCanvasObject={paintNode}
          nodeCanvasObjectMode={() => "replace"}
          nodePointerAreaPaint={paintNodeArea}
          onNodeClick={handleNodeClick}
          onNodeDragEnd={handleNodeDragEnd}
          onZoom={handleZoom}
          enableNodeDrag={true}
          enableZoomInteraction={true}
          enablePanInteraction={true}
          linkCanvasObject={paintLink}
          linkCanvasObjectMode={() => "replace"}
          linkDirectionalParticleWidth={3}
          linkDirectionalParticleSpeed={0.008}
          linkDirectionalParticleColor={(link: LinkObject<VizNode, VizLink>) => (link as unknown as VizLink).color}
          cooldownTicks={80}
          d3AlphaDecay={0.015}
          d3VelocityDecay={0.35}
          d3AlphaMin={0.005}
          minZoom={0.3}
          maxZoom={8}
          dagLevelDistance={80}
        />
      </div>

      {/* Log overlay — sits on top, gradient-fades into graph */}
      <div
        className="absolute top-0 left-0 bottom-0 flex flex-col pointer-events-none"
        style={{ width: feedW }}
      >
        {/* Gradient backdrop: solid base on left, fading to transparent on right.
             Uses mask-image instead of a color gradient to avoid 8-bit banding artefacts
             that appear as subtle vertical lines in dark-to-transparent transitions. */}
        <div
          className="absolute inset-0"
          style={{
            background: C.base,
            WebkitMaskImage: `linear-gradient(to right, white 45%, rgba(255,255,255,0.92) 55%, rgba(255,255,255,0.78) 63%, rgba(255,255,255,0.60) 71%, rgba(255,255,255,0.40) 79%, rgba(255,255,255,0.22) 86%, rgba(255,255,255,0.08) 93%, transparent 100%)`,
            maskImage: `linear-gradient(to right, white 45%, rgba(255,255,255,0.92) 55%, rgba(255,255,255,0.78) 63%, rgba(255,255,255,0.60) 71%, rgba(255,255,255,0.40) 79%, rgba(255,255,255,0.22) 86%, rgba(255,255,255,0.08) 93%, transparent 100%)`,
          }}
        />


        {/* Feed items — terminal style: newest at bottom, gradient fade */}
        <div ref={feedRef} className="flex-1 overflow-y-auto px-3 pb-2 flex flex-col justify-end gap-0.5 relative pointer-events-auto">
          {recentActivity.length === 0 ? (
            <div className="text-xs" style={{ color: C.mid }}>
              {mode === "reflect" && !reflectRunId ? "Select a past run to review"
                : mode === "live" && !isRunning ? ""
                : "Waiting for activity"}
            </div>
          ) : (
            recentActivity.map((item, i) => {
              // Sophisticated gradient: bottom (newest) is full opacity,
              // top (oldest) fades to near-invisible but still readable.
              // The curve is exponential so the fade is obvious and immersive.
              const n = recentActivity.length
              const position = n <= 1 ? 1 : i / (n - 1) // 0 = oldest, 1 = newest
              // Exponential curve for gradient: position^1.3
              // Min 0.2 so oldest is faded but comfortably readable
              const opacity = 0.2 + Math.pow(position, 1.3) * 0.8
              return (
                <div
                  key={item.time}
                  className="font-mono text-xs leading-relaxed"
                  style={{ color: item.color, opacity }}
                >
                  {item.text}
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* Controls overlay — positioned relative to full container */}

      {/* Zoom controls */}
        <div
          className="absolute bottom-3 right-3 flex items-center gap-1 rounded-lg px-1 py-0.5"
          style={{ background: C.surface + "cc" }}
        >
          <button
            className="flex items-center justify-center w-6 h-6 rounded transition-colors"
            style={{ color: C.muted }}
            onMouseEnter={(e) => { e.currentTarget.style.color = C.text }}
            onMouseLeave={(e) => { e.currentTarget.style.color = C.muted }}
            onClick={() => { const fg = graphRef.current; if (fg) { const z = fg.zoom() * 0.7; fg.zoom(z, 200) } }}
            title="Zoom out"
          >
            <Minus size={13} />
          </button>
          <span className="text-[10px] font-mono w-8 text-center" style={{ color: C.muted }}>{zoomLevel}%</span>
          <button
            className="flex items-center justify-center w-6 h-6 rounded transition-colors"
            style={{ color: C.muted }}
            onMouseEnter={(e) => { e.currentTarget.style.color = C.text }}
            onMouseLeave={(e) => { e.currentTarget.style.color = C.muted }}
            onClick={() => { const fg = graphRef.current; if (fg) { const z = fg.zoom() * 1.4; fg.zoom(z, 200) } }}
            title="Zoom in"
          >
            <Plus size={13} />
          </button>
          <button
            className="flex items-center justify-center w-6 h-6 rounded transition-colors"
            style={{ color: C.muted }}
            onMouseEnter={(e) => { e.currentTarget.style.color = C.text }}
            onMouseLeave={(e) => { e.currentTarget.style.color = C.muted }}
            onClick={() => {
              const fg = graphRef.current
              if (!fg) return
              // Center the diagram at the centroid of all nodes, offset for log panel
              const nodes = graphData.nodes
              if (nodes.length === 0) return
              let cx = 0, cy = 0
              for (const n of nodes) {
                cx += (n as NodeObject<VizNode>).x ?? 0
                cy += (n as NodeObject<VizNode>).y ?? 0
              }
              // Shift rightward to account for the log panel
              const panelOffset = feedW / 2 / fg.zoom()
              fg.centerAt(cx / nodes.length - panelOffset, cy / nodes.length, 400)
            }}
            title="Center diagram"
          >
            <Maximize2 size={11} />
          </button>
        </div>

      {/* Mode toggle — centered horizontally */}
        <div
          className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-2"
        >
          {/* Live / Reflect pill */}
          <div
            className="flex items-center gap-3 rounded-lg px-3 py-1.5"
            style={{ background: C.surface + "cc" }}
          >
            <button
              className="text-[11px] transition-colors cursor-pointer"
              style={{
                color: mode === "live" ? C.text : C.muted,
                fontWeight: mode === "live" ? 600 : 400,
              }}
              onClick={() => { setMode("live"); setReflectRunId(null); setReflectTrace([]); setPickerOpen(false) }}
            >
              Live
            </button>
            <button
              className="text-[11px] transition-colors cursor-pointer"
              style={{
                color: mode === "reflect" ? C.text : C.muted,
                fontWeight: mode === "reflect" ? 600 : 400,
              }}
              onClick={() => setMode("reflect")}
            >
              Reflect
            </button>

            {/* Status dot */}
            {(() => {
              const run = displayRun
              if (mode === "live" && !run) return null
              if (mode === "live" && run?.status === "running") {
                return (
                  <span
                    className="w-1.5 h-1.5 rounded-full flex-shrink-0 transition-opacity duration-700 ml-1"
                    style={{ background: C.success, opacity: pulse ? 1 : 0.3 }}
                  />
                )
              }
              if (run?.status === "failed") {
                return <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 ml-1" style={{ background: C.coral }} />
              }
              if (run?.status === "completed") {
                return <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 ml-1" style={{ background: C.mid }} />
              }
              return null
            })()}
          </div>

          {/* Run picker — always mounted, hidden when Live to avoid rerender */}
          <div
            className="relative transition-all duration-150"
            ref={pickerRef}
            style={{
              opacity: mode === "reflect" ? 1 : 0,
              pointerEvents: mode === "reflect" ? "auto" : "none",
              maxWidth: mode === "reflect" ? 220 : 0,
              clipPath: mode === "reflect" ? "none" : "inset(0)",
            }}
          >
            <button
              className="flex items-center gap-1.5 text-[11px] transition-colors cursor-pointer rounded-lg px-2.5 py-1.5 whitespace-nowrap"
              style={{ background: C.surface + "cc", color: reflectRunId ? C.text : C.muted }}
              onClick={() => setPickerOpen((v) => !v)}
            >
              <span className="truncate max-w-[140px]">
                {reflectRun
                  ? `${agents.find((a) => a.id === reflectRun.agentId)?.name ?? "Agent"} · ${new Date(reflectRun.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
                  : "Select run…"}
              </span>
              <ChevronDown size={11} className="shrink-0 opacity-50" />
            </button>

            {pickerOpen && mode === "reflect" && (
              <div
                className="absolute left-0 top-full mt-1.5 w-64 rounded-lg shadow-xl z-50 overflow-hidden max-h-56 overflow-y-auto"
                style={{ background: C.elevated, border: `1px solid rgba(255,255,255,0.08)` }}
              >
                {completedRuns.length === 0 ? (
                  <div className="px-3 py-2 text-xs" style={{ color: C.muted }}>No completed runs</div>
                ) : (
                  completedRuns.map((r) => {
                    const agent = agents.find((a) => a.id === r.agentId)
                    const date = new Date(r.createdAt)
                    const isSelected = r.id === reflectRunId
                    return (
                      <button
                        key={r.id}
                        className="flex flex-col w-full px-3 py-2 text-left text-xs transition-colors"
                        style={{
                          color: isSelected ? C.accent : C.text,
                          background: isSelected ? C.accent + "12" : "transparent",
                        }}
                        onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "rgba(255,255,255,0.04)" }}
                        onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = "transparent" }}
                        onClick={() => { setReflectRunId(r.id); setPickerOpen(false) }}
                      >
                        <span className="truncate">{agent?.name ?? "Agent"}</span>
                        <span className="truncate opacity-50">
                          {r.status} · {date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </button>
                    )
                  })
                )}
              </div>
            )}

            {loadingReflect && (
              <div className="text-[9px] mt-1 whitespace-nowrap" style={{ color: C.muted }}>Loading…</div>
            )}
          </div>
        </div>

        {/* Detail panel — click a node */}
        {selectedNode && detailInfo && (
          <div
            className="absolute top-3 right-3 rounded-lg px-4 py-3 font-mono max-w-[220px]"
            style={{ background: `${C.surface}ee`, border: `1px solid ${C.deep}60`, color: C.text }}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-[13px] font-semibold" style={{ color: C.accent }}>{detailInfo.title}</span>
              <button
                className="opacity-40 hover:opacity-100 ml-3 leading-none text-[16px]"
                style={{ color: C.muted }}
                onClick={() => setSelectedNode(null)}
              >
                ×
              </button>
            </div>
            {detailInfo.lines.map((line, i) => (
              <div key={i} className="flex justify-between gap-4 text-[11px] leading-relaxed">
                <span style={{ color: C.muted }}>{line.label}</span>
                <span className="font-medium">{line.value}</span>
              </div>
            ))}
          </div>
        )}
    </div>
  )
}
