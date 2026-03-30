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

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ForceGraphMethods, LinkObject, NodeObject } from "react-force-graph-2d"
import ForceGraph2D from "react-force-graph-2d"
import { api } from "../api"
import { useStore } from "../store"
import type { AgentDefinition } from "../types"

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
}

interface VizLink {
  source: string
  target: string
  agentId: string
  color: string
}

// ── Component ────────────────────────────────────────────────────

export function AgentViz() {
  const trace = useStore((s) => s.trace)
  const runs = useStore((s) => s.runs)
  const activeRunId = useStore((s) => s.activeRunId)

  const containerRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<ForceGraphMethods<NodeObject<VizNode>, LinkObject<VizNode, VizLink>>>(undefined)
  const [size, setSize] = useState({ w: 600, h: 400 })
  const [agents, setAgents] = useState<AgentDefinition[]>([])
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const prevTraceLen = useRef(0)

  // Feed width for the left panel
  const feedW = Math.min(260, size.w * 0.35)

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

  // Derive state
  const activeRun = runs.find((r) => r.id === activeRunId)
  const isRunning = activeRun?.status === "running"

  // Build tool stats from trace
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

  // Build graph data from agents — ONLY recompute when agent structure changes
  // Visual states (colors, running, stats) are handled in paintNode
  const graphData = useMemo(() => {
    const nodes: VizNode[] = []
    const links: VizLink[] = []
    const toolNodeIds = new Set<string>()

    agents.forEach((agent, idx) => {
      const agentColor = AGENT_COLORS[idx % AGENT_COLORS.length]
      const agentNodeId = `agent:${agent.id}`

      nodes.push({
        id: agentNodeId,
        type: "agent",
        label: agent.name,
        color: agentColor,
        agentId: agent.id,
        val: 5,
      })

      for (const toolId of agent.tools) {
        const toolNodeId = `tool:${toolId}`
        if (!toolNodeIds.has(toolNodeId)) {
          toolNodeIds.add(toolNodeId)
          nodes.push({
            id: toolNodeId,
            type: "tool",
            label: toolLabel(toolId),
            color: C.mid,
            toolId,
            val: 3,
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

  // Emit particles when new tool calls arrive
  useEffect(() => {
    if (trace.length <= prevTraceLen.current) {
      prevTraceLen.current = trace.length
      return
    }
    const newEntries = trace.slice(prevTraceLen.current)
    prevTraceLen.current = trace.length

    const fg = graphRef.current
    if (!fg) return

    for (const entry of newEntries) {
      if (entry.kind === "tool-call") {
        // Find the link for (active agent -> tool) and emit a particle
        const agentId = activeRun?.agentId
        if (!agentId) continue

        // Find the matching link object and emit
        const link = graphData.links.find(
          (l) => l.agentId === agentId && (typeof l.target === "string" ? l.target : (l.target as VizNode).id) === `tool:${entry.tool}`
        )
        if (link) {
          try { fg.emitParticle(link as LinkObject<VizNode, VizLink>) } catch { /* ok */ }
        }
      }
    }
  }, [trace, activeRun, graphData.links])

  // Fit to view on data change
  useEffect(() => {
    const fg = graphRef.current
    if (!fg || agents.length === 0) return
    const timer = setTimeout(() => fg.zoomToFit(400, 40), 300)
    return () => clearTimeout(timer)
  }, [agents.length])

  // Custom node renderer
  const paintNode = useCallback((node: NodeObject<VizNode>, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const x = node.x ?? 0
    const y = node.y ?? 0
    const r = node.type === "agent" ? 10 : 7

    if (node.type === "agent") {
      // Agent node: clean circle
      const isActive = activeRun?.agentId === node.agentId && isRunning

      // Subtle outer glow when running
      if (isActive) {
        ctx.fillStyle = node.color + "18"
        ctx.beginPath()
        ctx.arc(x, y, r * 1.8, 0, Math.PI * 2)
        ctx.fill()
      }

      // Main circle
      ctx.fillStyle = C.deep + "cc"
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()

      // Border
      ctx.strokeStyle = node.color + (isActive ? "cc" : "80")
      ctx.lineWidth = isActive ? 1.4 : 1
      ctx.stroke()

      // Inner dot
      ctx.fillStyle = isActive ? C.text + "aa" : C.muted + "50"
      ctx.beginPath()
      ctx.arc(x, y, r * 0.18, 0, Math.PI * 2)
      ctx.fill()

      // Label below
      ctx.font = `${Math.max(3, 10 / globalScale)}px sans-serif`
      ctx.fillStyle = C.text
      ctx.textAlign = "center"
      ctx.textBaseline = "top"
      ctx.fillText(node.label, x, y + r + 3)
    } else {
      // Tool node: minimal circle with label
      const stats = toolStats.get(node.toolId ?? "")
      const active = stats?.lastStatus === "running"
      const toolColor = active ? C.accent
        : stats?.lastStatus === "error" ? C.coral
        : stats?.lastStatus === "done" ? C.success
        : C.mid

      ctx.fillStyle = C.elevated
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()

      ctx.strokeStyle = toolColor + (active ? "cc" : "60")
      ctx.lineWidth = active ? 1.4 : 0.8
      ctx.stroke()

      // Small inner dot
      ctx.fillStyle = toolColor + (active ? "cc" : "50")
      ctx.beginPath()
      ctx.arc(x, y, r * 0.25, 0, Math.PI * 2)
      ctx.fill()

      // Call count — small inline number top-right
      if (stats && stats.calls > 0) {
        ctx.font = `bold ${Math.max(2, 5.5 / globalScale)}px sans-serif`
        ctx.fillStyle = toolColor
        ctx.textAlign = "center"
        ctx.textBaseline = "middle"
        ctx.fillText(stats.calls > 99 ? "99+" : String(stats.calls), x + r * 0.75, y - r * 0.7)
      }

      // Label below
      ctx.font = `${Math.max(2.5, 8 / globalScale)}px sans-serif`
      ctx.fillStyle = stats && stats.calls > 0 ? C.text : C.muted
      ctx.textAlign = "center"
      ctx.textBaseline = "top"
      ctx.fillText(node.label, x, y + r + 2)
    }
  }, [activeRun, isRunning, toolStats])

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

  // Status label
  const statusLabel = activeRun
    ? activeRun.status === "running" ? `Running iter ${currentIteration}`
      : activeRun.status === "completed" ? "Completed"
      : activeRun.status === "failed" ? "Failed"
      : activeRun.status
    : "Idle"

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
          { label: "Runs", value: String(agentRuns.length) },
          { label: "OK / Err", value: `${completed} / ${failed}` },
          ...(activeRun?.agentId === agentId ? [
            { label: "Status", value: activeRun.status },
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
  }, [selectedNode, agents, runs, activeRun, currentIteration, toolStats])

  // Activity feed — last 12 trace events (bigger since we have more space)
  const recentActivity = useMemo(() => {
    const items: Array<{ text: string; color: string; time: number }> = []
    for (let i = trace.length - 1; i >= 0 && items.length < 80; i--) {
      const e = trace[i]
      if (e.kind === "tool-call") {
        items.push({ text: `> ${toolLabel(e.tool)}(${e.argsSummary || "..."})`, color: C.accent, time: i })
      } else if (e.kind === "tool-result") {
        const preview = e.text.length > 80 ? e.text.slice(0, 77) + "..." : e.text
        items.push({ text: `< ${preview}`, color: C.success, time: i })
      } else if (e.kind === "tool-error") {
        items.push({ text: `x ${e.text.slice(0, 80)}`, color: C.coral, time: i })
      } else if (e.kind === "thinking") {
        items.push({ text: `~ ${e.text.slice(0, 70)}...`, color: C.peach, time: i })
      } else if (e.kind === "answer") {
        items.push({ text: `= ${e.text.slice(0, 80)}`, color: C.success, time: i })
      } else if (e.kind === "iteration") {
        items.push({ text: `  iter ${e.current}/${e.max}`, color: C.mid, time: i })
      }
    }
    return items.reverse()
  }, [trace])

  // Graph dimensions (right side, excluding feed panel)
  const graphW = size.w - feedW
  const graphH = size.h

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden select-none flex" style={{ background: C.base }}>

      {/* Left: activity feed */}
      <div
        className="flex flex-col h-full flex-shrink-0 overflow-hidden"
        style={{ width: feedW }}
      >
        {/* Status + agents — compact header */}
        <div className="flex items-center gap-2 px-3 py-2 flex-shrink-0">
          <span
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{ background: isRunning ? C.success : activeRun?.status === "failed" ? C.coral : C.mid }}
          />
          <span className="text-[11px] truncate" style={{ color: C.muted }}>{statusLabel}</span>
          {agents.length > 1 && agents.map((a, i) => (
            <span
              key={a.id}
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ background: AGENT_COLORS[i % AGENT_COLORS.length] }}
              title={a.name}
            />
          ))}
        </div>

        {/* Feed items — fills from top */}
        <div className="flex-1 overflow-y-auto px-3 pb-2 flex flex-col gap-px">
          {recentActivity.length === 0 ? (
            <div className="text-[10px]" style={{ color: C.mid }}>
              Waiting for activity
            </div>
          ) : (
            recentActivity.map((item, i) => (
              <div
                key={item.time}
                className="font-mono text-[9px] leading-relaxed"
                style={{ color: item.color, opacity: 0.4 + (i / recentActivity.length) * 0.6 }}
              >
                {item.text}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right: force graph */}
      <div className="flex-1 relative" style={{ minWidth: 0 }}>
        <ForceGraph2D
          ref={graphRef}
          graphData={graphData}
          width={graphW}
          height={graphH}
          backgroundColor={C.base}
          nodeCanvasObject={paintNode}
          nodeCanvasObjectMode={() => "replace"}
          nodePointerAreaPaint={paintNodeArea}
          onNodeClick={handleNodeClick}
          enableNodeDrag={true}
          enableZoomInteraction={true}
          enablePanInteraction={true}
          linkColor={(link: LinkObject<VizNode, VizLink>) => (link as unknown as VizLink).color + "30"}
          linkWidth={1}
          linkDirectionalParticleWidth={3}
          linkDirectionalParticleSpeed={0.008}
          linkDirectionalParticleColor={(link: LinkObject<VizNode, VizLink>) => (link as unknown as VizLink).color}
          cooldownTicks={80}
          d3AlphaDecay={0.03}
          d3VelocityDecay={0.3}
          minZoom={0.5}
          maxZoom={8}
        />

        {/* Detail panel — click a node to see stats */}
        {selectedNode && detailInfo && (
          <div
            className="absolute top-2 right-3 rounded px-3 py-2 text-xs font-mono max-w-[180px]"
            style={{ background: `${C.surface}e8`, border: `1px solid ${C.deep}`, color: C.text }}
          >
            <div className="flex items-center justify-between mb-1.5">
              <span style={{ color: C.accent, fontWeight: 600, fontSize: 11 }}>{detailInfo.title}</span>
              <button
                className="opacity-40 hover:opacity-100 ml-2 leading-none"
                style={{ color: C.muted, fontSize: 14 }}
                onClick={() => setSelectedNode(null)}
              >
                x
              </button>
            </div>
            {detailInfo.lines.map((line, i) => (
              <div key={i} className="flex justify-between gap-3 text-[10px] leading-snug">
                <span style={{ color: C.muted }}>{line.label}</span>
                <span>{line.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
