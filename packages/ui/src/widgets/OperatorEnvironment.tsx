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
    Columns2,
    FolderTree,
    History,
    MessageSquare,
    PanelBottom,
    Rows2,
    Search,
    Terminal,
    X,
    type LucideIcon
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../api"
import { useStore } from "../store"
import type { AgentDefinition, PolicyRule, ToolInfo, TraceEntry } from "../types"
import { fmtTokens } from "../util"
import { AuditPanel, FeedPanel, OutputPanel, ProblemsPanel } from "./ioe/bottom"
import { ChatPanel } from "./ioe/chat"
import {
    C,
    buildChatMessages,
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
    type SidebarSection,
    type UsageData
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
  const setSteps = useStore((s) => s.setSteps)
  const setLogs = useStore((s) => s.setLogs)
  const setAudit = useStore((s) => s.setAudit)
  const pendingInput = useStore((s) => s.pendingInput)
  const clearPendingInput = useStore((s) => s.clearPendingInput)
  // ── API data ──────────────────────────────────────────────────
  const [agents, setAgents] = useState<AgentDefinition[]>([])
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [policies, setPolicies] = useState<PolicyRule[]>([])
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [llm, setLlm] = useState<LlmConfig | null>(null)
  const [health, setHealth] = useState<HealthData | null>(null)

  // ── Layout state ──────────────────────────────────────────────
  const [sidebarSection, setSidebarSection] = useState<SidebarSection>("explorer")
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [sidebarSplit, setSidebarSplit] = useState(false)
  const [sidebarBottomSection, setSidebarBottomSection] = useState<SidebarSection>("runs")
  const [bottomVisible, setBottomVisible] = useState(true)
  const [chatVisible, setChatVisible] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  const [editorTab, setEditorTab] = useState<EditorTab>("trace")
  const [editorSplit, setEditorSplit] = useState(false)
  const [editorRightTab, setEditorRightTab] = useState<EditorTab>("dag")
  const [bottomTab, setBottomTab] = useState<BottomTab>("output")
  const [bottomSplit, setBottomSplit] = useState(false)
  const [bottomRightTab, setBottomRightTab] = useState<BottomTab>("audit")

  // ── Resizable panels ──────────────────────────────────────────
  const sidebar = useResizable(260, "horizontal")
  const sidebarV = useResizable(200, "vertical")
  const bottom = useResizable(200, "vertical", true)
  const chatR = useResizable(300, "horizontal", true)

  // ── Operational state ─────────────────────────────────────────
  const [goalInput, setGoalInput] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [rollbackMsg, setRollbackMsg] = useState<string | null>(null)
  const [expandedDag, setExpandedDag] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set())

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
  // ── Load run data on selection ─────────────────────────────────────
  useEffect(() => {
    if (!activeRunId) return
    api.getRun(activeRunId).then((detail) => {
      if (detail.data?.steps) setSteps(detail.data.steps)
      if (detail.audit) setAudit(detail.audit)
      if (detail.logs) setLogs(detail.logs)
    }).catch(() => {})
    api.getRunTrace(activeRunId).then((entries) => {
      if (Array.isArray(entries) && entries.length > 0) setTrace(entries as unknown as TraceEntry[])
    }).catch(() => {})
  }, [activeRunId, setSteps, setAudit, setLogs, setTrace])
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
  const chatMessages = useMemo(() => buildChatMessages(trace), [trace])
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

  const handleRespondToInput = useCallback(async (response: string) => {
    if (!pendingInput) return
    try {
      await api.respondToRun(pendingInput.runId, response)
    } catch {
      /* swallow */
    }
    clearPendingInput()
  }, [pendingInput, clearPendingInput])

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
  ]

  // ═════════════════════════════════════════════════════════════════
  //  RENDER
  // ═════════════════════════════════════════════════════════════════

  const renderSidebarSection = (section: SidebarSection) => {
    if (section === "explorer")
      return (
        <ExplorerPanel run={activeRun} agents={agents} tools={tools}
          policies={policies} llm={llm} health={health} usage={usage} />
      )
    if (section === "runs")
      return <RunsPanel runs={runs} activeRunId={activeRunId} onSelect={setActiveRun} />
    if (section === "agents")
      return <AgentsToolsPanel agents={agents} tools={tools} policies={policies} />
    if (section === "notifications")
      return <NotificationsPanel notifications={notifications} onRead={markNotificationRead} />
    return null
  }

  const renderBottomContent = (tab: BottomTab) => {
    if (tab === "output") return <OutputPanel logs={logs} />
    if (tab === "audit") return <AuditPanel audit={audit} />
    if (tab === "feed") return <FeedPanel items={feedItems} />
    if (tab === "problems") return <ProblemsPanel problems={problems} />
    return null
  }

  const renderEditorContent = (tab: EditorTab) => {
    if (tab === "trace") return <TracePanel trace={trace} />
    if (tab === "dag")
      return <DagPanel nodes={dagNodes} expanded={expandedDag} onToggle={setExpandedDag} />
    if (tab === "timeline")
      return (
        <TimelinePanel steps={steps} expanded={expandedSteps}
          onToggle={(id) => setExpandedSteps((prev) => {
            const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n
          })} />
      )
    if (tab === "details")
      return <DetailsPanel run={activeRun} toolStats={toolStats} liveUsage={liveUsage} usage={usage} />
    return null
  }

  return (
    <div
      className="flex flex-col h-full overflow-hidden"
      style={{ background: C.base, color: C.text, fontFamily: "var(--font-sans)", fontSize: 13 }}
    >
      {/* ── Search Bar (top) ─────────────────────────────── */}
      {searchOpen && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 shrink-0"
          style={{ background: C.surface, borderBottom: `1px solid ${C.borderSolid}` }}
        >
          <Search size={14} style={{ color: C.dim }} />
          <input
            className="flex-1 bg-transparent outline-none text-[13px]"
            style={{ color: C.text, caretColor: C.accent }}
            placeholder="Search runs, trace, audit..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoFocus
          />
          <button
            className="p-1 rounded hover:bg-white/10 transition-colors"
            style={{ color: C.muted }}
            onClick={() => { setSearchOpen(false); setSearchQuery("") }}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {searchOpen && searchResults && (
        <div
          className="max-h-48 overflow-y-auto px-3 py-1 shrink-0"
          style={{ background: C.elevated, borderBottom: `1px solid ${C.borderSolid}` }}
        >
          <SearchResultsList results={searchResults} />
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* ── Activity Bar ──────────────────────────────────── */}
        <div
          className="flex flex-col items-center py-1 shrink-0 select-none"
          style={{ width: 48, background: C.surface, borderRight: `1px solid ${C.borderSolid}` }}
        >
          {activityItems.map((item) => {
            const active = sidebarVisible && sidebarSection === item.id
            return (
              <button
                key={item.id}
                className="relative flex items-center justify-center w-12 h-10 transition-colors"
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
                <item.Icon size={20} />
                {item.badge != null && item.badge > 0 && (
                  <span
                    className="absolute top-1 right-1 min-w-[16px] h-4 rounded-full text-[11px] font-semibold flex items-center justify-center px-1"
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
            className="flex items-center justify-center w-12 h-9 transition-colors"
            style={{ color: searchOpen ? C.text : C.muted }}
            onClick={() => setSearchOpen((v) => !v)}
            title="Search"
          >
            <Search size={18} />
          </button>
          <button
            className="flex items-center justify-center w-12 h-9 transition-colors"
            style={{ color: bottomVisible ? C.text : C.muted }}
            onClick={() => setBottomVisible((v) => !v)}
            title="Toggle bottom panel"
          >
            <PanelBottom size={18} />
          </button>
          <button
            className="flex items-center justify-center w-12 h-9 transition-colors"
            style={{ color: chatVisible ? C.text : C.muted }}
            onClick={() => setChatVisible((v) => !v)}
            title="Toggle Copilot chat"
          >
            <MessageSquare size={18} />
          </button>
        </div>

        {/* ── Sidebar ────────────────────────────────────────── */}
        {sidebarVisible && (
          <div
            className="flex flex-col h-full overflow-hidden shrink-0"
            style={{ width: sidebar.size, borderRight: `1px solid ${C.borderSolid}`, background: C.surface }}
          >
            <div
              className="flex items-center justify-between px-3 py-1.5 text-[13px] uppercase tracking-wider shrink-0 select-none cursor-default"
              style={{ color: C.muted, borderBottom: `1px solid ${C.border}` }}
            >
              <span>{sidebarSection}</span>
              <button
                className="p-0.5 rounded hover:bg-white/5 transition-colors"
                style={{ color: sidebarSplit ? C.text : C.muted }}
                onClick={() => setSidebarSplit((v) => !v)}
                title="Toggle split sidebar"
              >
                <Rows2 size={14} />
              </button>
            </div>

            {sidebarSplit ? (
              <>
                <div style={{ height: sidebarV.size }} className="overflow-y-auto shrink-0 min-h-0">
                  {renderSidebarSection(sidebarSection)}
                </div>
                <div
                  className="h-1 cursor-row-resize shrink-0 hover:bg-accent/30 active:bg-accent/50 transition-colors"
                  onMouseDown={sidebarV.onMouseDown}
                />
                <div className="flex-1 overflow-hidden flex flex-col min-h-0">
                  <div
                    className="flex items-center gap-0.5 px-2 py-1 shrink-0 select-none"
                    style={{ borderTop: `1px solid ${C.border}` }}
                  >
                    {(["explorer", "runs", "agents", "notifications"] as SidebarSection[]).map((s) => (
                      <button
                        key={s}
                        className="px-1.5 py-0.5 text-[13px] rounded capitalize cursor-pointer"
                        style={{
                          color: sidebarBottomSection === s ? C.text : C.dim,
                          background: sidebarBottomSection === s ? C.elevated : "transparent",
                        }}
                        onClick={() => setSidebarBottomSection(s)}
                      >
                        {s === "notifications" ? "notif" : s}
                      </button>
                    ))}
                  </div>
                  <div className="flex-1 overflow-y-auto min-h-0">
                    {renderSidebarSection(sidebarBottomSection)}
                  </div>
                </div>
              </>
            ) : (
              <div className="flex-1 overflow-y-auto min-h-0">
                {renderSidebarSection(sidebarSection)}
              </div>
            )}
          </div>
        )}
        {sidebarVisible && (
          <div
            className="w-1 cursor-col-resize shrink-0 hover:bg-accent/30 active:bg-accent/50 transition-colors"
            onMouseDown={sidebar.onMouseDown}
          />
        )}

        {/* ── Editor + Bottom ───────────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* Objective bar */}
          <div
            className="flex items-center gap-2 px-3 py-1.5 shrink-0 text-[13px]"
            style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}
          >
            <CircleDot size={14} style={{ color: activeRun ? statusDot(activeRun.status) : C.dim }} />
            <span className="truncate flex-1" style={{ color: activeRun ? C.text : C.muted }}>
              {activeRun ? activeRun.goal : "No active run — submit a goal below"}
            </span>
            {currentIteration && (
              <span className="shrink-0 text-[13px]" style={{ color: C.dim }}>
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
                <span className="text-[13px] ml-1" style={{ color: C.warning }}>{rollbackMsg}</span>
              )}
            </div>
          </div>

          {/* Editor tabs + split toggle */}
          <div
            className="flex items-center shrink-0"
            style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}
          >
            <EditorTabs
              current={editorTab}
              onChange={setEditorTab}
              trace={trace}
              dagNodes={dagNodes}
              steps={steps}
            />
            <div className="flex-1" />
            <button
              className="px-2 py-1 mr-1 rounded transition-colors"
              style={{ color: editorSplit ? C.text : C.dim }}
              onClick={() => setEditorSplit((v) => !v)}
              title="Split editor"
            >
              <Columns2 size={14} />
            </button>
          </div>

          {/* Editor content (split or single) */}
          <div className="flex flex-1 min-h-0" style={{ background: C.base }}>
            <div className="flex-1 overflow-y-auto min-h-0">
              {renderEditorContent(editorTab)}
            </div>
            {editorSplit && (
              <>
                <div className="w-px shrink-0" style={{ background: C.borderSolid }} />
                <div className="flex flex-col min-w-0 min-h-0" style={{ width: "50%" }}>
                  <div
                    className="flex items-center shrink-0 select-none"
                    style={{ borderBottom: `1px solid ${C.border}`, background: C.surface }}
                  >
                    {(["trace", "dag", "timeline", "details"] as EditorTab[]).map((tab) => (
                      <button
                        key={tab}
                        className="px-2.5 py-1 text-[13px] transition-colors capitalize cursor-pointer"
                        style={{
                          color: editorRightTab === tab ? C.text : C.dim,
                          borderBottom: editorRightTab === tab ? `1px solid ${C.cyan}` : "1px solid transparent",
                        }}
                        onClick={() => setEditorRightTab(tab)}
                      >
                        {tab}
                      </button>
                    ))}
                  </div>
                  <div className="flex-1 overflow-y-auto min-h-0">
                    {renderEditorContent(editorRightTab)}
                  </div>
                </div>
              </>
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
              <div className="flex items-center shrink-0 select-none" style={{ borderBottom: `1px solid ${C.border}` }}>
                {(["output", "audit", "feed", "problems"] as BottomTab[]).map((tab) => (
                  <button
                    key={tab}
                    className="px-3 py-1 text-[13px] uppercase tracking-wide transition-colors cursor-pointer"
                    style={{
                      color: bottomTab === tab ? C.text : C.muted,
                      borderBottom: bottomTab === tab ? `1px solid ${C.accent}` : "1px solid transparent",
                    }}
                    onClick={() => setBottomTab(tab)}
                  >
                    {tab}
                    {tab === "problems" && problems.length > 0 && (
                      <span
                        className="ml-1.5 text-[11px] px-1 rounded-full"
                        style={{ background: C.error + "30", color: C.error }}
                      >
                        {problems.length}
                      </span>
                    )}
                  </button>
                ))}
                <div className="flex-1" />
                {bottomSplit && (
                  <>
                    {(["output", "audit", "feed", "problems"] as BottomTab[]).map((tab) => (
                      <button
                        key={`r-${tab}`}
                        className="px-2 py-1 text-[13px] uppercase tracking-wide transition-colors cursor-pointer"
                        style={{
                          color: bottomRightTab === tab ? C.text : C.dim,
                          borderBottom: bottomRightTab === tab ? `1px solid ${C.cyan}` : "1px solid transparent",
                        }}
                        onClick={() => setBottomRightTab(tab)}
                      >
                        {tab}
                      </button>
                    ))}
                  </>
                )}
                <button
                  className="px-2 py-1 mr-1 rounded transition-colors"
                  style={{ color: bottomSplit ? C.text : C.dim }}
                  onClick={() => setBottomSplit((v) => !v)}
                  title="Split bottom panel"
                >
                  <Columns2 size={13} />
                </button>
              </div>

              <div
                ref={logRef}
                className="flex flex-1 min-h-0 font-mono text-[13px] leading-relaxed"
              >
                <div className="flex-1 overflow-y-auto min-h-0">
                  {renderBottomContent(bottomTab)}
                </div>
                {bottomSplit && (
                  <>
                    <div className="w-px shrink-0" style={{ background: C.borderSolid }} />
                    <div className="flex-1 overflow-y-auto min-h-0">
                      {renderBottomContent(bottomRightTab)}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Operator prompt (only when chat is hidden) */}
          {!chatVisible && (
            <div
              className="shrink-0 flex items-center gap-2 px-3 py-1.5"
              style={{ borderTop: `1px solid ${C.borderSolid}`, background: C.surface }}
            >
              {agents.length > 0 && (
                <select
                  className="text-[13px] rounded px-1.5 py-1 outline-none cursor-pointer"
                  style={{ background: C.elevated, color: C.muted, border: `1px solid ${C.border}` }}
                  value={selectedAgentId ?? agents[0]?.id ?? ""}
                  onChange={(e) => setSelectedAgent(e.target.value || null)}
                >
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              )}
              <Terminal size={14} style={{ color: C.dim }} />
              <input
                type="text"
                className="flex-1 bg-transparent outline-none text-[13px]"
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
                <span className="text-[13px] shrink-0" style={{ color: C.dim }}>
                  {fmtK(liveUsage.totalTokens)} tk
                </span>
              )}
            </div>
          )}
        </div>

        {/* ── Chat Panel (right) ────────────────────────────── */}
        {chatVisible && (
          <div
            className="w-1 cursor-col-resize shrink-0 hover:bg-accent/30 active:bg-accent/50 transition-colors"
            onMouseDown={chatR.onMouseDown}
          />
        )}
        {chatVisible && (
          <div className="shrink-0 h-full" style={{ width: chatR.size, borderLeft: `1px solid ${C.borderSolid}` }}>
            <ChatPanel
              messages={chatMessages}
              goalInput={goalInput}
              onGoalChange={setGoalInput}
              onSubmit={handleSubmitGoal}
              isRunning={isRunning ?? false}
              submitting={submitting}
              pendingInput={pendingInput}
              onRespond={handleRespondToInput}
            />
          </div>
        )}
      </div>

      {/* ── Status Bar ──────────────────────────────────────────── */}
      <div
        className="flex items-center gap-3 px-3 py-0.5 text-[13px] shrink-0"
        style={{
          background: isRunning ? C.accent : C.surface,
          borderTop: `1px solid ${isRunning ? C.accentHover : C.borderSolid}`,
          color: isRunning ? C.text : C.muted,
        }}
      >
        <span className="flex items-center gap-1">
          <span
            className="inline-block w-2 h-2 rounded-full"
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
