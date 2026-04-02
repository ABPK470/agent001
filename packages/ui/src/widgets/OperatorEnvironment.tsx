/**
 * OperatorEnvironment — Integrated Operator Environment (IOE).
 *
 * VS Code-inspired single-pane-of-glass for the entire agent platform.
 * This is the main orchestrator that composes sub-components from ./ioe/.
 */

import {
    Bell,
    Bot,
    CircleDot,
    FolderTree,
    History,
    PanelBottom,
    PanelLeft,
    PanelRight,
    Search,
    Settings,
    Terminal,
    type LucideIcon,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../api"
import { useStore } from "../store"
import type { AgentDefinition, PolicyRule, ToolInfo, TraceEntry } from "../types"
import { fmtTokens } from "../util"
import { AuditPanel, FeedPanel, OutputPanel, ProblemsPanel } from "./ioe/bottom"
import {
    C,
    buildDagNodes,
    buildFeedItems,
    buildProblems,
    buildSearchResults,
    buildToolStats,
    fmtK,
    statusDot,
    type BottomTab,
    type EditorTab,
    type HealthData,
    type LlmConfig,
    type PanelSide,
    type SidebarSection,
    type UsageData,
} from "./ioe/constants"
import { DagPanel, DetailsPanel, EditorTabs, TimelinePanel, TracePanel } from "./ioe/editors"
import { ActionBtn, useResizable } from "./ioe/primitives"
import {
    AgentsToolsPanel,
    ExplorerPanel,
    NotificationsPanel,
    RunsPanel,
    SearchResultsList,
} from "./ioe/sidebar"

// ═══════════════════════════════════════════════════════════════════
//  MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════

export function OperatorEnvironment() {
  // ── Store ─────────────────────────────────────────────────────
  const connected = useStore((s) => s.connected)
  const runs = useStore((s) => s.runs) ?? []
  const activeRunId = useStore((s) => s.activeRunId)
  const setActiveRun = useStore((s) => s.setActiveRun)
  const steps = useStore((s) => s.steps)
  const logs = useStore((s) => s.logs)
  const audit = useStore((s) => s.audit)
  const trace = useStore((s) => s.trace)
  const liveUsage = useStore((s) => s.liveUsage)
  const notifications = useStore((s) => s.notifications)
  const unreadCount = useStore((s) => s.unreadCount)
  const markNotificationRead = useStore((s) => s.markNotificationRead)
  const selectedAgentId = useStore((s) => s.selectedAgentId)
  const setSelectedAgent = useStore((s) => s.setSelectedAgent)
  const setTrace = useStore((s) => s.setTrace)

  // ── API data ──────────────────────────────────────────────────
  const [agents, setAgents] = useState<AgentDefinition[]>([])
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [policies, setPolicies] = useState<PolicyRule[]>([])
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [llm, setLlm] = useState<LlmConfig | null>(null)
  const [health, setHealth] = useState<HealthData | null>(null)

  // ── Layout state ──────────────────────────────────────────────
  const [sidebarSection, setSidebarSection] = useState<SidebarSection>("explorer")
  const [sidebarSide, setSidebarSide] = useState<PanelSide>("left")
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [bottomVisible, setBottomVisible] = useState(true)
  const [editorTab, setEditorTab] = useState<EditorTab>("trace")
  const [bottomTab, setBottomTab] = useState<BottomTab>("output")

  // ── Resizable panels ──────────────────────────────────────────
  const sidebar = useResizable(240, 160, 480, "horizontal")
  const bottom = useResizable(200, 100, 500, "vertical")

  // ── Operational state ─────────────────────────────────────────
  const [goalInput, setGoalInput] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [rollbackMsg, setRollbackMsg] = useState<string | null>(null)
  const [expandedDag, setExpandedDag] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set())

  const inputRef = useRef<HTMLInputElement>(null)
  const logRef = useRef<HTMLDivElement>(null)

  // ── Fetch system data ─────────────────────────────────────────
  useEffect(() => {
    api.listAgents().then(setAgents).catch(() => {})
    api.listTools().then(setTools).catch(() => {})
    api.listPolicies().then(setPolicies).catch(() => {})
    api.getUsage().then(setUsage).catch(() => {})
    api.getLlmConfig().then(setLlm).catch(() => {})
    api.health().then(setHealth).catch(() => {})
  }, [runs.length])

  // ── Auto-scroll logs ──────────────────────────────────────────
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs.length])

  // ── Derived data ──────────────────────────────────────────────
  const activeRun = runs.find((r) => r.id === activeRunId)
  const isRunning = activeRun?.status === "running"
  const isFailed = activeRun?.status === "failed"

  const currentIteration = useMemo(() => {
    for (let i = trace.length - 1; i >= 0; i--) {
      if (trace[i].kind === "iteration") return trace[i] as Extract<TraceEntry, { kind: "iteration" }>
    }
    return null
  }, [trace])

  const toolStats = useMemo(() => buildToolStats(steps), [steps])
  const dagNodes = useMemo(() => buildDagNodes(trace), [trace])
  const feedItems = useMemo(() => buildFeedItems(trace), [trace])
  const problems = useMemo(() => buildProblems(trace, steps), [trace, steps])
  const searchResults = useMemo(
    () => buildSearchResults(searchQuery, runs, trace, audit),
    [searchQuery, runs, trace, audit],
  )

  // ── Actions ───────────────────────────────────────────────────
  const handleSubmitGoal = useCallback(async () => {
    const goal = goalInput.trim()
    if (!goal || submitting) return
    setSubmitting(true)
    try {
      const agentId = selectedAgentId ?? agents[0]?.id
      const { runId } = await api.startRun(goal, agentId || undefined)
      setActiveRun(runId)
      setGoalInput("")
    } catch {
      /* swallow */
    }
    setSubmitting(false)
  }, [goalInput, submitting, selectedAgentId, agents, setActiveRun])

  const handleCancel = useCallback(async () => {
    if (activeRun) await api.cancelRun(activeRun.id).catch(() => {})
  }, [activeRun])

  const handleResume = useCallback(async () => {
    if (!activeRun) return
    try {
      const { runId } = await api.resumeRun(activeRun.id)
      if (runId) {
        setTrace([])
        setActiveRun(runId)
      }
    } catch {
      /* swallow */
    }
  }, [activeRun, setActiveRun, setTrace])

  const handleRollback = useCallback(async () => {
    if (!activeRun) return
    setRollbackMsg(null)
    try {
      const preview = await api.previewRollback(activeRun.id)
      if (preview.wouldCompensate.length === 0) {
        setRollbackMsg("nothing to rollback")
        return
      }
      if (preview.wouldFail.length > 0) {
        setRollbackMsg(`blocked: ${preview.wouldFail[0].reason}`)
        return
      }
      const result = await api.rollbackRun(activeRun.id)
      setRollbackMsg(`rolled back ${result.compensated} effects`)
    } catch {
      setRollbackMsg("rollback failed")
    }
  }, [activeRun])

  // ── Activity bar items ────────────────────────────────────────
  const activityItems: Array<{ id: SidebarSection; Icon: LucideIcon; label: string; badge?: number }> = [
    { id: "explorer", Icon: FolderTree, label: "Explorer" },
    { id: "runs", Icon: History, label: "Run History" },
    { id: "agents", Icon: Bot, label: "Agents & Tools" },
    { id: "notifications", Icon: Bell, label: "Notifications", badge: unreadCount },
    { id: "search", Icon: Search, label: "Search" },
  ]

  // ═════════════════════════════════════════════════════════════════
  //  RENDER — Sidebar content
  // ═════════════════════════════════════════════════════════════════

  const sidebarContent = sidebarVisible ? (
    <div
      className="flex flex-col h-full overflow-hidden shrink-0"
      style={{
        width: sidebar.size,
        borderRight: sidebarSide === "left" ? `1px solid ${C.borderSolid}` : undefined,
        borderLeft: sidebarSide === "right" ? `1px solid ${C.borderSolid}` : undefined,
        background: C.surface,
      }}
    >
      <div
        className="flex items-center justify-between px-3 py-1.5 text-[11px] uppercase tracking-wider shrink-0 select-none"
        style={{ color: C.muted, borderBottom: `1px solid ${C.border}` }}
      >
        <span>{sidebarSection}</span>
        <button
          className="p-0.5 rounded hover:bg-white/5 transition-colors"
          style={{ color: C.muted }}
          onClick={() => setSidebarSide((s) => (s === "left" ? "right" : "left"))}
          title={`Move to ${sidebarSide === "left" ? "right" : "left"}`}
        >
          {sidebarSide === "left" ? <PanelRight size={13} /> : <PanelLeft size={13} />}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {sidebarSection === "explorer" && (
          <ExplorerPanel
            run={activeRun}
            agents={agents}
            tools={tools}
            policies={policies}
            llm={llm}
            health={health}
            usage={usage}
          />
        )}
        {sidebarSection === "runs" && (
          <RunsPanel runs={runs} activeRunId={activeRunId} onSelect={setActiveRun} />
        )}
        {sidebarSection === "agents" && (
          <AgentsToolsPanel agents={agents} tools={tools} policies={policies} />
        )}
        {sidebarSection === "notifications" && (
          <NotificationsPanel notifications={notifications} onRead={markNotificationRead} />
        )}
        {sidebarSection === "search" && (
          <div className="p-2">
            <input
              className="w-full px-2 py-1.5 rounded text-xs outline-none"
              style={{ background: C.elevated, color: C.text, border: `1px solid ${C.border}` }}
              placeholder="Search runs, trace, audit..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <SearchResultsList results={searchResults} />
          </div>
        )}
      </div>
    </div>
  ) : null

  const sidebarResize = sidebarVisible ? (
    <div
      className="w-1 cursor-col-resize shrink-0 hover:bg-accent/30 active:bg-accent/50 transition-colors"
      onMouseDown={sidebar.onMouseDown}
    />
  ) : null

  // ═════════════════════════════════════════════════════════════════
  //  RENDER — Main layout
  // ═════════════════════════════════════════════════════════════════

  return (
    <div
      className="flex flex-col h-full overflow-hidden select-none"
      style={{ background: C.base, color: C.text, fontFamily: "var(--font-sans)" }}
    >
      <div className="flex flex-1 min-h-0">
        {/* ── Activity Bar ──────────────────────────────────── */}
        <div
          className="flex flex-col items-center py-1 shrink-0"
          style={{ width: 40, background: C.surface, borderRight: `1px solid ${C.borderSolid}` }}
        >
          {activityItems.map((item) => {
            const active = sidebarVisible && sidebarSection === item.id
            return (
              <button
                key={item.id}
                className="relative flex items-center justify-center w-10 h-10 transition-colors"
                style={{
                  color: active ? C.text : C.muted,
                  borderLeft: active ? `2px solid ${C.accent}` : "2px solid transparent",
                }}
                onClick={() => {
                  if (sidebarSection === item.id && sidebarVisible) setSidebarVisible(false)
                  else {
                    setSidebarSection(item.id)
                    setSidebarVisible(true)
                  }
                }}
                title={item.label}
              >
                <item.Icon size={18} />
                {item.badge != null && item.badge > 0 && (
                  <span
                    className="absolute top-1 right-1.5 min-w-[14px] h-3.5 rounded-full text-[9px] font-semibold flex items-center justify-center px-1"
                    style={{ background: C.accent, color: C.text }}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            )
          })}

          <div className="flex-1" />

          <button
            className="flex items-center justify-center w-10 h-8 transition-colors"
            style={{ color: bottomVisible ? C.text : C.muted }}
            onClick={() => setBottomVisible((v) => !v)}
            title="Toggle bottom panel"
          >
            <PanelBottom size={16} />
          </button>
          <button
            className="flex items-center justify-center w-10 h-8 transition-colors"
            style={{ color: C.muted }}
            onClick={() => setSidebarSide((s) => (s === "left" ? "right" : "left"))}
            title="Switch sidebar side"
          >
            <Settings size={16} />
          </button>
        </div>

        {/* ── Left sidebar ──────────────────────────────────── */}
        {sidebarSide === "left" && sidebarContent}
        {sidebarSide === "left" && sidebarResize}

        {/* ── Editor + Bottom ───────────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* Objective bar */}
          <div
            className="flex items-center gap-2 px-3 py-1 shrink-0 text-xs"
            style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}
          >
            <CircleDot size={12} style={{ color: activeRun ? statusDot(activeRun.status) : C.dim }} />
            <span className="truncate flex-1" style={{ color: activeRun ? C.text : C.muted }}>
              {activeRun ? activeRun.goal : "No active run — submit a goal below"}
            </span>
            {currentIteration && (
              <span className="shrink-0" style={{ color: C.dim }}>
                iter {currentIteration.current}/{currentIteration.max}
              </span>
            )}
            <div className="flex items-center gap-1 shrink-0">
              {isRunning && <ActionBtn label="CANCEL" color={C.coral} onClick={handleCancel} />}
              {isFailed && <ActionBtn label="RESUME" color={C.peach} onClick={handleResume} />}
              {(activeRun?.status === "completed" || isFailed) && (
                <ActionBtn label="ROLLBACK" color={C.warning} onClick={handleRollback} />
              )}
              {rollbackMsg && (
                <span className="text-[10px] ml-1" style={{ color: C.warning }}>{rollbackMsg}</span>
              )}
            </div>
          </div>

          {/* Editor tabs */}
          <EditorTabs
            current={editorTab}
            onChange={setEditorTab}
            trace={trace}
            dagNodes={dagNodes}
            steps={steps}
          />

          {/* Editor content */}
          <div className="flex-1 overflow-y-auto min-h-0" style={{ background: C.base }}>
            {editorTab === "trace" && <TracePanel trace={trace} />}
            {editorTab === "dag" && (
              <DagPanel nodes={dagNodes} expanded={expandedDag} onToggle={setExpandedDag} />
            )}
            {editorTab === "timeline" && (
              <TimelinePanel
                steps={steps}
                expanded={expandedSteps}
                onToggle={(id) =>
                  setExpandedSteps((prev) => {
                    const n = new Set(prev)
                    n.has(id) ? n.delete(id) : n.add(id)
                    return n
                  })
                }
              />
            )}
            {editorTab === "details" && (
              <DetailsPanel run={activeRun} toolStats={toolStats} liveUsage={liveUsage} usage={usage} />
            )}
          </div>

          {/* Bottom panel resize */}
          {bottomVisible && (
            <div
              className="h-1 cursor-row-resize shrink-0 hover:bg-accent/30 active:bg-accent/50 transition-colors"
              onMouseDown={bottom.onMouseDown}
            />
          )}

          {/* Bottom panel */}
          {bottomVisible && (
            <div
              className="shrink-0 flex flex-col"
              style={{ height: bottom.size, borderTop: `1px solid ${C.borderSolid}` }}
            >
              <div className="flex items-center shrink-0" style={{ borderBottom: `1px solid ${C.border}` }}>
                {(["output", "audit", "feed", "problems"] as BottomTab[]).map((tab) => (
                  <button
                    key={tab}
                    className="px-3 py-1 text-[11px] uppercase tracking-wide transition-colors"
                    style={{
                      color: bottomTab === tab ? C.text : C.muted,
                      borderBottom: bottomTab === tab ? `1px solid ${C.accent}` : "1px solid transparent",
                    }}
                    onClick={() => setBottomTab(tab)}
                  >
                    {tab}
                    {tab === "problems" && problems.length > 0 && (
                      <span
                        className="ml-1.5 text-[9px] px-1 rounded-full"
                        style={{ background: C.error + "30", color: C.error }}
                      >
                        {problems.length}
                      </span>
                    )}
                  </button>
                ))}
              </div>

              <div
                ref={logRef}
                className="flex-1 overflow-y-auto min-h-0 font-mono text-[11px] leading-relaxed"
              >
                {bottomTab === "output" && <OutputPanel logs={logs} />}
                {bottomTab === "audit" && <AuditPanel audit={audit} />}
                {bottomTab === "feed" && <FeedPanel items={feedItems} />}
                {bottomTab === "problems" && <ProblemsPanel problems={problems} />}
              </div>
            </div>
          )}

          {/* Operator prompt */}
          <div
            className="shrink-0 flex items-center gap-2 px-3 py-1.5"
            style={{ borderTop: `1px solid ${C.borderSolid}`, background: C.surface }}
          >
            {agents.length > 0 && (
              <select
                className="text-[11px] rounded px-1.5 py-1 outline-none cursor-pointer"
                style={{ background: C.elevated, color: C.muted, border: `1px solid ${C.border}` }}
                value={selectedAgentId ?? agents[0]?.id ?? ""}
                onChange={(e) => setSelectedAgent(e.target.value || null)}
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            )}
            <Terminal size={13} style={{ color: C.dim }} />
            <input
              ref={inputRef}
              type="text"
              className="flex-1 bg-transparent outline-none text-xs"
              style={{ color: C.text, caretColor: C.accent }}
              placeholder={isRunning ? "agent running..." : "enter goal and press Enter"}
              value={goalInput}
              onChange={(e) => setGoalInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmitGoal()
              }}
              disabled={isRunning || submitting}
            />
            {liveUsage.totalTokens > 0 && (
              <span className="text-[10px] shrink-0" style={{ color: C.dim }}>
                {fmtK(liveUsage.totalTokens)} tk
              </span>
            )}
          </div>
        </div>

        {/* ── Right sidebar ─────────────────────────────────── */}
        {sidebarSide === "right" && sidebarResize}
        {sidebarSide === "right" && sidebarContent}
      </div>

      {/* ── Status Bar ──────────────────────────────────────────── */}
      <div
        className="flex items-center gap-3 px-3 py-0.5 text-[11px] shrink-0"
        style={{
          background: isRunning ? C.accent : C.surface,
          borderTop: `1px solid ${isRunning ? C.accentHover : C.borderSolid}`,
          color: isRunning ? C.text : C.muted,
        }}
      >
        <span className="flex items-center gap-1">
          <span
            className="inline-block w-1.5 h-1.5 rounded-full"
            style={{ background: connected ? C.success : C.error }}
          />
          {connected ? "connected" : "offline"}
        </span>
        {activeRun && (
          <>
            <span>{activeRun.status.toUpperCase()}</span>
            <span className="opacity-60">│</span>
          </>
        )}
        {llm && <span>{llm.provider}/{llm.model}</span>}
        {health && <span>sys: {health.status}</span>}
        <span className="opacity-60">│</span>
        <span>tools: {tools.length}</span>
        <span>agents: {agents.length}</span>
        <span>policies: {policies.length}</span>
        {usage && (
          <>
            <span className="opacity-60">│</span>
            <span>{fmtTokens(usage.totals.totalTokens)} tokens total</span>
            <span>{usage.totals.runCount} runs</span>
          </>
        )}
        <div className="flex-1" />
        <span>
          {runs.length > 0
            ? `${runs.filter((r) => r.status === "completed").length}✓ ${runs.filter((r) => r.status === "failed").length}✗`
            : ""}
        </span>
      </div>
    </div>
  )
}
