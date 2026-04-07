/**
 * OperatorEnvironment — Integrated Operator Environment (IOE).
 *
 * VS Code-inspired single-pane-of-glass for the entire agent platform.
 * This is the main orchestrator that composes sub-components from ./ioe/.
 */

import {
    CircleDot,
    Columns2,
    Download,
    GitCompareArrows,
    History,
    Info,
    MessageSquare,
    PanelBottom,
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
import { AuditPanel, OutputPanel, ProblemsPanel } from "./ioe/bottom"
import { ChatPanel } from "./ioe/chat"
import {
    C,
    buildChatMessages,
    buildProblems,
    buildSearchResults,
    dur,
    fmtK,
    statusDot,
    type BottomTab,
    type EditorTab,
    type HealthData,
    type LlmConfig,
    type SidebarSection,
    type UsageData
} from "./ioe/constants"
import { EditorTabs, LlmCallsPanel, MapPanel, TracePanel, exportAgentLoop } from "./ioe/editors"
import { ActionBtn, TipProvider, useResizable } from "./ioe/primitives"
import {
    ComparePanel,
    DetailsPanel,
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

  // ── Layout state (persisted in store — survives view switches + reload) ──
  const ioeLayout = useStore((s) => s.ioeLayout)
  const setIoeLayout = useStore((s) => s.setIoeLayout)

  const sidebarSection = ioeLayout.sidebarSection as SidebarSection
  const setSidebarSection = useCallback((v: SidebarSection) => setIoeLayout({ sidebarSection: v }), [setIoeLayout])
  const sidebarVisible = ioeLayout.sidebarVisible
  const setSidebarVisible = useCallback((v: boolean) => setIoeLayout({ sidebarVisible: v }), [setIoeLayout])
  const bottomVisible = ioeLayout.bottomVisible
  const setBottomVisible = useCallback((v: boolean) => setIoeLayout({ bottomVisible: v }), [setIoeLayout])
  const chatVisible = ioeLayout.chatVisible
  const setChatVisible = useCallback((v: boolean) => setIoeLayout({ chatVisible: v }), [setIoeLayout])
  const [searchOpen, setSearchOpen] = useState(false)
  const editorTab = ioeLayout.editorTab as EditorTab
  const setEditorTab = useCallback((v: EditorTab) => setIoeLayout({ editorTab: v }), [setIoeLayout])
  const editorSplit = ioeLayout.editorSplit
  const setEditorSplit = useCallback((v: boolean) => setIoeLayout({ editorSplit: v }), [setIoeLayout])
  const editorRightTab = ioeLayout.editorRightTab as EditorTab
  const setEditorRightTab = useCallback((v: EditorTab) => setIoeLayout({ editorRightTab: v }), [setIoeLayout])
  const bottomTab = ioeLayout.bottomTab as BottomTab
  const setBottomTab = useCallback((v: BottomTab) => setIoeLayout({ bottomTab: v }), [setIoeLayout])
  const bottomSplit = ioeLayout.bottomSplit
  const setBottomSplit = useCallback((v: boolean) => setIoeLayout({ bottomSplit: v }), [setIoeLayout])
  const bottomRightTab = ioeLayout.bottomRightTab as BottomTab
  const setBottomRightTab = useCallback((v: BottomTab) => setIoeLayout({ bottomRightTab: v }), [setIoeLayout])

  // ── Resizable panels (init from persisted layout, sync back on change) ──
  const sidebar = useResizable(ioeLayout.sidebarWidth, "horizontal")
  const bottom = useResizable(ioeLayout.bottomHeight, "vertical", true)
  const chatR = useResizable(ioeLayout.chatWidth, "horizontal", true)

  // Persist panel sizes back to store (debounced — only on actual changes)
  useEffect(() => { setIoeLayout({ sidebarWidth: sidebar.size }) }, [sidebar.size, setIoeLayout])
  useEffect(() => { setIoeLayout({ bottomHeight: bottom.size }) }, [bottom.size, setIoeLayout])
  useEffect(() => { setIoeLayout({ chatWidth: chatR.size }) }, [chatR.size, setIoeLayout])

  // ── Operational state ─────────────────────────────────────────
  const [goalInput, setGoalInput] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [rollbackMsg, setRollbackMsg] = useState<string | null>(null)
  const [rolledBack, setRolledBack] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")

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
    // Only fetch trace from DB for completed/historical runs.
    // For running/pending runs, trace streams in live via WS — fetching
    // from DB would clobber the live stream with a stale snapshot.
    const run = useStore.getState().runs.find((r) => r.id === activeRunId)
    const isLive = !run || run.status === "running" || run.status === "pending"
    if (!isLive) {
      api.getRunTrace(activeRunId).then((entries) => {
        if (Array.isArray(entries) && entries.length > 0) setTrace(entries as unknown as TraceEntry[])
      }).catch(() => {})
    }
  }, [activeRunId, setSteps, setAudit, setLogs, setTrace])
  // ── Derived data ──────────────────────────────────────────────
  const activeRun = runs.find((r) => r.id === activeRunId)
  const isRunning = activeRun?.status === "running"
  const isFailed = activeRun?.status === "failed"
  const isCancelled = activeRun?.status === "cancelled"

  const currentIteration = useMemo(() => {
    for (let i = trace.length - 1; i >= 0; i--) {
      if (trace[i].kind === "iteration") return trace[i] as Extract<TraceEntry, { kind: "iteration" }>
    }
    return null
  }, [trace])

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

  const handleRerun = useCallback(async () => {
    if (!activeRun) return
    try {
      const { runId } = await api.rerunRun(activeRun.id)
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
        setRolledBack(true)
        return
      }
      if (preview.wouldFail.length > 0) {
        setRollbackMsg(`blocked: ${preview.wouldFail[0].reason}`)
        return
      }
      const result = await api.rollbackRun(activeRun.id)
      setRollbackMsg(`rolled back ${result.compensated} effects`)
      setRolledBack(true)
    } catch {
      setRollbackMsg("rollback failed")
    }
  }, [activeRun])

  // Reset rolledBack state when switching runs
  useEffect(() => { setRolledBack(false) }, [activeRunId])

  // Auto-dismiss rollback message after 8 seconds
  useEffect(() => {
    if (!rollbackMsg) return
    const timer = setTimeout(() => setRollbackMsg(null), 8000)
    return () => clearTimeout(timer)
  }, [rollbackMsg])

  // ── Comparison state ───────────────────────────────────────────
  const [compareResult, setCompareResult] = useState<{
    sameGoal: boolean
    goalSimilarity: number
    toolOverlap: number
    toolCallDelta: number
    iterationDelta: number
    errorRateDelta: number
    moreEfficient: "a" | "b" | "equal"
    outcomeA: "answer" | "error" | "incomplete"
    outcomeB: "answer" | "error" | "incomplete"
    summary: string
  } | null>(null)
  const [compareLoading, setCompareLoading] = useState(false)
  const [compareError, setCompareError] = useState<string | null>(null)

  // ── Activity bar items ────────────────────────────────────────
  const activityItems: Array<{ id: SidebarSection; Icon: LucideIcon; label: string; badge?: number }> = [
    { id: "runs", Icon: History, label: "Runs" },
    { id: "compare", Icon: GitCompareArrows, label: "Compare Runs" },
    { id: "details", Icon: Info, label: "Details" },
  ]

  // ═════════════════════════════════════════════════════════════════
  //  RENDER
  // ═════════════════════════════════════════════════════════════════

  const handleCompare = useCallback(async (idA: string, idB: string) => {
    setCompareResult(null)
    setCompareError(null)
    setCompareLoading(true)
    try {
      const result = await api.compareTrajectories(idA, idB)
      setCompareResult(result)
    } catch (err) {
      setCompareError(err instanceof Error ? err.message : "Comparison failed")
    }
    setCompareLoading(false)
  }, [])

  const renderSidebarSection = (section: SidebarSection) => {
    if (section === "runs")
      return <RunsPanel runs={runs} activeRunId={activeRunId} onSelect={setActiveRun} />
    if (section === "compare")
      return <ComparePanel runs={runs} onCompare={handleCompare}
        result={compareResult} loading={compareLoading} error={compareError} />
    if (section === "details")
      return (
        <DetailsPanel run={activeRun} agents={agents} tools={tools}
          policies={policies} llm={llm} health={health} usage={usage} />
      )
    return null
  }

  const renderBottomContent = (tab: BottomTab) => {
    if (tab === "output") return <OutputPanel logs={logs} />
    if (tab === "audit") return <AuditPanel audit={audit} />
    if (tab === "problems") return <ProblemsPanel problems={problems} />
    return null
  }

  const renderEditorContent = (tab: EditorTab) => {
    if (tab === "trace") return <TracePanel trace={trace} />
    if (tab === "llm-calls") return <LlmCallsPanel trace={trace} />
    if (tab === "map")
      return <MapPanel trace={trace} run={activeRun} agents={agents} />
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
            className="p-1 rounded hover:bg-white/10 transition-colors cursor-pointer"
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
          style={{ width: 52, background: C.surface, borderRight: `1px solid ${C.borderSolid}`, paddingRight: 4 }}
        >
          {activityItems.map((item) => {
            const active = sidebarVisible && sidebarSection === item.id
            return (
              <button
                key={item.id}
                className="relative flex items-center justify-center w-12 h-10 cursor-pointer group"
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
                <item.Icon size={22} className="transition-[filter] duration-150 group-hover:brightness-150" />
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
            className="flex items-center justify-center w-12 h-9 cursor-pointer group"
            style={{ color: searchOpen ? C.text : C.muted }}
            onClick={() => setSearchOpen((v) => !v)}
            title="Search"
          >
            <Search size={20} className="transition-[filter] duration-150 group-hover:brightness-150" />
          </button>
          <button
            className="flex items-center justify-center w-12 h-9 cursor-pointer group"
            style={{ color: bottomVisible ? C.text : C.muted }}
            onClick={() => setBottomVisible(!bottomVisible)}
            title="Toggle bottom panel"
          >
            <PanelBottom size={20} className="transition-[filter] duration-150 group-hover:brightness-150" />
          </button>
          <button
            className="flex items-center justify-center w-12 h-9 cursor-pointer group"
            style={{ color: chatVisible ? C.text : C.muted }}
            onClick={() => setChatVisible(!chatVisible)}
            title="Toggle Copilot chat"
          >
            <MessageSquare size={20} className="transition-[filter] duration-150 group-hover:brightness-150" />
          </button>
        </div>

        {/* ── Sidebar ────────────────────────────────────────── */}
        {sidebarVisible && (
          <div
            className="flex flex-col h-full overflow-hidden shrink-0"
            data-sidebar-panel
            style={{ width: sidebar.size, borderRight: `1px solid ${C.borderSolid}`, background: C.surface }}
          >
          <TipProvider>
            <div
              className="flex items-center justify-between px-3 py-1.5 text-[13px] uppercase tracking-wider shrink-0 select-none cursor-default"
              style={{ color: C.muted, borderBottom: `1px solid ${C.border}` }}
            >
              <span>{sidebarSection}</span>
            </div>

            <div className="flex-1 overflow-y-auto min-h-0">
              {renderSidebarSection(sidebarSection)}
            </div>
          </TipProvider>
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
              {(isFailed || isCancelled) && <ActionBtn label="RESUME" color={C.peach} onClick={handleResume} />}
              {(activeRun?.status === "completed" || isFailed || isCancelled) && (
                <ActionBtn label="RE-RUN" color={C.accent} onClick={handleRerun} />
              )}
              {(activeRun?.status === "completed" || isFailed || isCancelled) && !rolledBack && (
                <ActionBtn label="ROLLBACK" color={C.warning} onClick={handleRollback} />
              )}
              {rollbackMsg && (
                <span className="text-[13px] ml-1" style={{ color: C.warning }}>{rollbackMsg}</span>
              )}
            </div>
          </div>

          {/* Editor content (split or single) */}
          <div className="flex flex-1 min-h-0" style={{ background: C.base }}>
            {/* Left panel */}
            <div className="flex flex-col flex-1 min-w-0 min-h-0">
              {/* Left tab bar */}
              <div className="flex items-center shrink-0 select-none" style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
                <EditorTabs
                  current={editorTab}
                  onChange={setEditorTab}
                  trace={trace}
                />
                <div className="flex-1" />
                {editorTab === "llm-calls" && trace.length > 0 && (
                  <button
                    className="px-2 py-1 mr-0.5 rounded transition-colors cursor-pointer hover:bg-white/[0.06]"
                    style={{ color: C.dim }}
                    onClick={() => exportAgentLoop(trace)}
                    title="Export Agent Loop"
                  >
                    <Download size={14} />
                  </button>
                )}
                <button
                  className="px-2 py-1 mr-1 rounded transition-colors cursor-pointer hover:bg-white/[0.06]"
                  style={{ color: editorSplit ? C.text : C.dim }}
                  onClick={() => setEditorSplit(!editorSplit)}
                  title="Split editor"
                >
                  <Columns2 size={14} />
                </button>
              </div>
              {/* Left content */}
              <div className="flex-1 overflow-y-auto min-h-0">
                {renderEditorContent(editorTab)}
              </div>
            </div>

            {editorSplit && (
              <>
                <div className="w-px shrink-0" style={{ background: C.borderSolid }} />
                {/* Right panel */}
                <div className="flex flex-col flex-1 min-w-0 min-h-0">
                  {/* Right tab bar (same structure as left) */}
                  <div className="flex items-center shrink-0 select-none" style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
                    <EditorTabs
                      current={editorRightTab}
                      onChange={setEditorRightTab}
                      trace={trace}
                    />
                    <div className="flex-1" />
                    {editorRightTab === "llm-calls" && trace.length > 0 && (
                      <button
                        className="px-2 py-1 mr-1 rounded transition-colors cursor-pointer hover:bg-white/[0.06]"
                        style={{ color: C.dim }}
                        onClick={() => exportAgentLoop(trace)}
                        title="Export Agent Loop"
                      >
                        <Download size={14} />
                      </button>
                    )}
                  </div>
                  {/* Right content */}
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
                {(["output", "audit", "problems"] as BottomTab[]).map((tab) => (
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
                    {(["output", "audit", "problems"] as BottomTab[]).map((tab) => (
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
                  className="px-2 py-1 mr-1 rounded transition-colors cursor-pointer hover:bg-white/[0.06]"
                  style={{ color: bottomSplit ? C.text : C.dim }}
                  onClick={() => setBottomSplit(!bottomSplit)}
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
          {connected ? "WS" : "offline"}
        </span>
        {activeRun && (
          <>
            <span>{activeRun.status.toUpperCase()}</span>
            <span className="opacity-60">│</span>
          </>
        )}
        {llm && <span>{llm.provider}/{llm.model}</span>}
        {health && <span>sys:{health.status}</span>}
        <span className="opacity-60">│</span>
        <span>T:{tools.length}</span>
        <span>A:{agents.length}</span>
        <span>P:{policies.length}</span>
        {activeRun && (
          <>
            <span className="opacity-60">│</span>
            <span>{fmtK(liveUsage.totalTokens)}tk</span>
            <span>{liveUsage.llmCalls}calls</span>
            <span>{steps.length}steps</span>
            {activeRun.createdAt && (
              <span>{dur(activeRun.createdAt, activeRun.completedAt)}</span>
            )}
          </>
        )}
        {usage && (
          <>
            <span className="opacity-60">│</span>
            <span>{fmtTokens(usage.totals.totalTokens)}tk total</span>
            <span>{usage.totals.runCount}runs</span>
          </>
        )}
        <div className="flex-1" />
        <span>
          {usage
            ? `${usage.totals.completedRuns}✓ ${usage.totals.failedRuns}✗`
            : ""}
        </span>
      </div>
    </div>
  )
}
