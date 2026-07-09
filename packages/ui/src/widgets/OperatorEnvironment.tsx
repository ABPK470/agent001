/**
 * OperatorEnvironment — Integrated Operator Environment (IOE).
 *
 * VS Code-inspired single-pane-of-glass for the entire agent platform.
 * This is the main orchestrator that composes sub-components from ./ioe/.
 */

import {
    Columns2,
    Download,
    GitCompareArrows,
    History,
    Info,
    MessageSquare,
    PanelBottom,
    Rows2,
    Search,
    Square,
    Terminal,
    X,
    type LucideIcon
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../api"
import { RunStatus } from "../enums"
import { useContainerSize } from "../hooks/useContainerSize"
import { useMe } from "../hooks/useMe"
import { ThreadRunsPanel } from "../features/threads/ThreadRunsPanel"
import { useStore } from "../store"
import { useComposerDraft } from "../chat/useComposerDraft"
import { useChatSlashActions } from "../chat/useChatSlashActions"
import { coerceSlashOnlyInput } from "../chat/commands"
import { useSlashCommandInput } from "../chat/useSlashCommandInput"
import { useCommandConsole } from "../chat/useCommandConsole"
import { ChatComposerShell } from "../chat/ChatComposerShell"
import type { AgentDefinition, PolicyRule, ToolInfo, TraceEntry } from "../types"
import { fmtTokens } from "../util"
import { AuditPanel, OutputPanel, ProblemsPanel } from "./ioe/bottom"
import { ChatPanel, type FileAttachment } from "./ioe/chat"
import {
    BottomTab,
    C,
    EditorTab,
    SidebarSection,
    buildChatMessages,
    buildProblems,
    buildSearchResults,
    dur,
    fmtK,
    type HealthData,
    type LlmConfig,
    type UsageData
} from "./ioe/constants"
import { BusFeedPanel, EditorTabs, LlmCallsPanel, MapPanel, ToolTimelinePanel, exportAgentLoop } from "./ioe/editors"
import { ActionBtn, TipProvider, useResizable } from "./ioe/primitives"
import {
    ComparePanel,
    DetailsPanel,
    SearchResultsList,
} from "./ioe/sidebar"

// ═══════════════════════════════════════════════════════════════════
//  MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════

const TOOL_LABELS: Record<string, string> = {
  search_catalog:        "Searching catalog",
  inspect_definition:    "Inspecting definition",
  explore_mssql_schema:  "Exploring schema",
  query_mssql:           "Running query",
  profile_data:          "Profiling data",
  discover_relationships:"Discovering relationships",
  read_file:             "Reading file",
  write_file:            "Writing file",
  append_file:           "Appending file",
  replace_in_file:       "Editing file",
  list_directory:        "Listing directory",
  search_files:          "Searching files",
  run_command:           "Running command",
  fetch_url:             "Fetching URL",
  think:                 "Thinking",
  ask_user:              "Asking user",
}

export function OperatorEnvironment() {
  // ── Auth / role (Phase E.5 — gates admin-only UI surfaces) ───
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false

  // ── Store ─────────────────────────────────────────────────────
  const connected = useStore((s) => s.connected)
  const runs = useStore((s) => s.runs) ?? []
  const activeRunId = useStore((s) => s.activeRunId)
  const activeThreadId = useStore((s) => s.activeThreadId)
  const { draft: goalInput, setDraft: setGoalInput, clearDraft: clearGoalInput } = useComposerDraft(activeThreadId)
  const setActiveRun = useStore((s) => s.setActiveRun)
  const upsertRun = useStore((s) => s.upsertRun)
  const steps = useStore((s) => s.steps)
  const logs = useStore((s) => s.logs)
  const audit = useStore((s) => s.audit)
  const trace = useStore((s) => s.trace)
  const busMessages = useStore((s) => s.busMessages)
  const helpUnread = useStore((s) => s.helpUnread)
  const ackBusHelp = useStore((s) => s.ackBusHelp)
  const liveUsage = useStore((s) => s.liveUsage)
  const selectedAgentId = useStore((s) => s.selectedAgentId)
  const setSelectedAgent = useStore((s) => s.setSelectedAgent)
  const setTrace = useStore((s) => s.setTrace)
  const setSteps = useStore((s) => s.setSteps)
  const setAudit = useStore((s) => s.setAudit)
  const pendingInput = useStore((s) => s.pendingInput)
  const clearPendingInput = useStore((s) => s.clearPendingInput)
  const executingToolCalls = useStore((s) => s.executingToolCalls)
  const pendingKill = useStore((s) => s.pendingKill)
  const setPendingKill = useStore((s) => s.setPendingKill)
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
  const sidebarSplit = ioeLayout.sidebarSplit
  const setSidebarSplit = useCallback((v: boolean) => setIoeLayout({ sidebarSplit: v }), [setIoeLayout])
  const sidebarBottomSection = (ioeLayout.sidebarBottomSection ?? SidebarSection.Runs) as SidebarSection
  const setSidebarBottomSection = useCallback((v: SidebarSection) => setIoeLayout({ sidebarBottomSection: v }), [setIoeLayout])
  const sidebarSplitRatio = ioeLayout.sidebarSplitRatio ?? 0.5
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
  const [goalAttachments, setGoalAttachments] = useState<FileAttachment[]>([])
  const [submitting, setSubmitting] = useState(false)
  const cmdConsole = useCommandConsole()
  const [rollbackMsg, setRollbackMsg] = useState<string | null>(null)
  const [workspaceMsg, setWorkspaceMsg] = useState<string | null>(null)
  const [applyingWorkspace, setApplyingWorkspace] = useState(false)
  const [rolledBack, setRolledBack] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")

  const logRef = useRef<HTMLDivElement>(null)
  const goalFileInputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const { width: rootWidth } = useContainerSize(rootRef)
  const compact = rootWidth > 0 && rootWidth < 800
  const sidebarAutoCollapsed = useRef(false)

  // Auto-collapse sidebar on first render when widget is narrow
  useEffect(() => {
    if (rootWidth === 0 || sidebarAutoCollapsed.current) return
    sidebarAutoCollapsed.current = true
    if (compact) setSidebarVisible(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootWidth])
  useEffect(() => {
    api.listAgents().then(setAgents).catch(() => {})
    api.listTools().then(setTools).catch(() => {})
    api.listPolicies().then(setPolicies).catch(() => {})
    api.getUsage().then(setUsage).catch(() => {})
    api.getLlmConfig().then(setLlm).catch(() => {})
    api.health().then(setHealth).catch(() => {})
  }, [runs.length, activeRunId])

  // ── Auto-scroll logs ──────────────────────────────────────────
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs.length])
  // ── Derived data ──────────────────────────────────────────────
  const activeRun = runs.find((r) => r.id === activeRunId)
  const isRunning = activeRun?.status === RunStatus.Running
  const isFailed = activeRun?.status === RunStatus.Failed
  const isCancelled = activeRun?.status === RunStatus.Cancelled
  // Crashed = the server died mid-run (recovery.ts marks any Running/Pending/
  // Planning rows as Crashed on boot). It's terminal, so the loop is
  // guaranteed not to be alive. Treat it exactly like Failed/Cancelled —
  // user-controlled RESUME (if a checkpoint exists) or RE-RUN.
  const isCrashed = activeRun?.status === RunStatus.Crashed
  const pendingWorkspaceChanges = activeRun?.pendingWorkspaceChanges ?? 0
  const runBusy =
    activeRun?.status === RunStatus.Running ||
    activeRun?.status === RunStatus.Pending ||
    activeRun?.status === RunStatus.Planning

  const scopedRuns = useMemo(
    () => runs.filter((r) => r.threadId === activeThreadId),
    [runs, activeThreadId],
  )

  const { tryDispatchSlash, slashCommands, slashOnlyMode } = useChatSlashActions({
    activeThreadId,
    runs: scopedRuns,
    runStatus: activeRun?.status,
    hasPendingInput: Boolean(pendingInput),
    onRunStarted: (runId) => setActiveRun(runId),
    console: cmdConsole.api,
    openFilePicker: () => goalFileInputRef.current?.click(),
  })

  useEffect(() => {
    if (!slashOnlyMode) return
    if (goalInput && !goalInput.startsWith("/")) clearGoalInput()
    if (goalAttachments.length > 0) setGoalAttachments([])
  }, [slashOnlyMode, goalInput, goalAttachments.length, clearGoalInput])

  const collapseComposer = useCallback(() => {
    cmdConsole.clear()
    clearGoalInput()
  }, [cmdConsole, clearGoalInput])

  const hasResult = cmdConsole.pinnedOpen && cmdConsole.lines.length > 0
  const { palette: compactSlashPalette, handleKeyDown: handleCompactSlashKeyDown } = useSlashCommandInput({
    value: goalInput,
    onChange: setGoalInput,
    commands: slashCommands,
    disabled: submitting || !!pendingInput,
    variant: "ioe",
    onCollapse: collapseComposer,
    hasResult,
  })

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
  const streamingAnswer = useStore((s) => s.streamingAnswer)

  const currentActivity = useMemo(() => {
    if (!activeRun || activeRun.status === RunStatus.Pending) return null
    if (activeRun.status === RunStatus.Planning) return "Planning"
    if (activeRun.status !== RunStatus.Running) return null
    const running = [...steps].reverse().find((s) => s.status === RunStatus.Running)
    if (running) return TOOL_LABELS[running.action] ?? running.name
    for (let i = trace.length - 1; i >= 0; i--) {
      const e = trace[i]
      if (e.kind === "tool-call") return TOOL_LABELS[e.tool] ?? e.tool
      if (e.kind === "iteration") return `iter ${e.current} / ${e.max}`
      if (e.kind === "delegation-start") return "Delegating to sub-agent"
    }
    return null
  }, [activeRun, steps, trace])
  // ── Actions ───────────────────────────────────────────────────
  const handleSubmitGoal = useCallback(async () => {
    const goal = goalInput.trim()
    if (!goal && goalAttachments.length === 0) return
    if (submitting) return

    if (slashOnlyMode && !goal.startsWith("/")) return

    if (goal.startsWith("/")) {
      const handled = await tryDispatchSlash(goal)
      if (handled) {
        clearGoalInput()
        return
      }
    }

    if (runBusy) return
    setSubmitting(true)
    try {
      // Goal text is sent verbatim. Attachments travel as durable
      // attachmentIds; the agent calls list_attachments / read_attachment /
      // import_attachment to inspect or pull them into the sandbox.
      const attachmentIds = goalAttachments.map((a) => a.id)
      const agentId = selectedAgentId ?? agents[0]?.id
      const threadId = useStore.getState().activeThreadId
      if (!threadId) return
      const { runId } = await api.startRun(goal, agentId || undefined, attachmentIds, threadId)
      setActiveRun(runId)
      clearGoalInput()
      setGoalAttachments([])
    } catch {
      /* swallow */
    }
    setSubmitting(false)
  }, [goalInput, goalAttachments, submitting, selectedAgentId, agents, setActiveRun, tryDispatchSlash, runBusy, clearGoalInput])

  const handleRespondToInput = useCallback(async (response: string) => {
    if (!pendingInput) return
    clearPendingInput()
    try {
      await api.respondToRun(pendingInput.runId, response)
    } catch {
      /* swallow */
    }
  }, [pendingInput, clearPendingInput])

  const handleKillToolCall = useCallback(async (message: string) => {
    if (!pendingKill) return
    try {
      await api.killToolCall(pendingKill.runId, pendingKill.toolCallId, message)
    } catch {
      /* swallow */
    }
    setPendingKill(null)
  }, [pendingKill, setPendingKill])

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

  const handleApplyWorkspace = useCallback(async () => {
    if (!activeRun || applyingWorkspace) return
    setApplyingWorkspace(true)
    setWorkspaceMsg(null)
    try {
      const result = await api.applyRunWorkspaceDiff(activeRun.id)
      if (!result) {
        setWorkspaceMsg("nothing to apply")
        return
      }
      const total = result.applied.added + result.applied.modified + result.applied.deleted
      upsertRun({ id: activeRun.id, pendingWorkspaceChanges: 0 })
      setWorkspaceMsg(`applied ${total} change${total === 1 ? "" : "s"}`)
    } catch {
      setWorkspaceMsg("apply failed")
    } finally {
      setApplyingWorkspace(false)
    }
  }, [activeRun, applyingWorkspace, upsertRun])

  // Reset rolledBack state when switching runs
  useEffect(() => { setRolledBack(false) }, [activeRunId])

  // Auto-dismiss rollback message after 8 seconds
  useEffect(() => {
    if (!rollbackMsg) return
    const timer = setTimeout(() => setRollbackMsg(null), 8000)
    return () => clearTimeout(timer)
  }, [rollbackMsg])

  useEffect(() => {
    if (!workspaceMsg) return
    const timer = setTimeout(() => setWorkspaceMsg(null), 8000)
    return () => clearTimeout(timer)
  }, [workspaceMsg])

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
    { id: SidebarSection.Runs, Icon: History, label: "Runs" },
    { id: SidebarSection.Compare, Icon: GitCompareArrows, label: "Compare Runs" },
    { id: SidebarSection.Details, Icon: Info, label: "Details" },
  ]

  const renderSidebarTabs = (
    current: SidebarSection,
    onChange: (section: SidebarSection) => void,
    showSplitToggle = false,
  ) => (
    <div className="flex h-9 items-stretch shrink-0" style={{ borderBottom: `1px solid ${C.border}` }}>
      <div className="flex min-w-0 flex-1 overflow-x-auto">
        {activityItems.map((item) => {
          const active = current === item.id
          return (
            <button
              key={item.id}
              className="h-full px-3 text-[12px] uppercase tracking-wide whitespace-nowrap transition-colors cursor-pointer border-r last:border-r-0"
              style={{
                color: active ? C.text : C.muted,
                background: active ? C.base : "transparent",
                borderBottom: active ? `1px solid ${C.accent}` : "1px solid transparent",
                borderRightColor: C.border,
              }}
              onClick={() => onChange(item.id)}
              title={item.label}
            >
              {item.label}
            </button>
          )
        })}
      </div>
      {showSplitToggle && (
        <button
          className="px-2 mx-1 my-1 rounded transition-colors cursor-pointer hover:bg-overlay-3"
          style={{ color: sidebarSplit ? C.text : C.dim }}
          onClick={() => setSidebarSplit(!sidebarSplit)}
          title={sidebarSplit ? "Unsplit sidebar" : "Split sidebar"}
        >
          <Rows2 size={14} />
        </button>
      )}
    </div>
  )

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
    if (section === SidebarSection.Runs)
      return <ThreadRunsPanel variant="ioe" />
    if (section === SidebarSection.Compare)
      return <ComparePanel runs={runs} onCompare={handleCompare}
        result={compareResult} loading={compareLoading} error={compareError} />
    if (section === SidebarSection.Details)
      return (
        <DetailsPanel run={activeRun} agents={agents} tools={tools}
          policies={policies} llm={llm} health={health} usage={usage} />
      )
    return null
  }

  const renderBottomContent = (tab: BottomTab) => {
    if (tab === BottomTab.Output) return <OutputPanel logs={logs} />
    if (tab === BottomTab.Audit) return <AuditPanel audit={audit} />
    if (tab === BottomTab.Problems) return <ProblemsPanel problems={problems} />
    return null
  }

  const renderEditorContent = (tab: EditorTab) => {
    if (tab === EditorTab.ToolTimeline) return <ToolTimelinePanel steps={steps} />
    if (tab === EditorTab.LlmCalls) return <LlmCallsPanel trace={trace} />
    if (tab === EditorTab.Map)
      return <MapPanel trace={trace} run={activeRun} agents={agents} />
    if (tab === EditorTab.Bus) {
      // Phase E.5: bus feed is admin-only. Non-admin selects fall back
      // to the trace panel (the default tab they would otherwise see).
      if (!isAdmin) return <LlmCallsPanel trace={trace} />
      return <BusFeedPanel messages={busMessages} helpUnread={helpUnread} onAck={ackBusHelp} />
    }
    // Fallback for old persisted "trace" → show tool-timeline
    return <ToolTimelinePanel steps={steps} />
  }

  return (
    <div
      ref={rootRef}
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
            className="p-1 rounded hover:bg-overlay-3 transition-colors cursor-pointer"
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
          style={{ width: compact ? 40 : 52, background: C.surface, borderRight: `1px solid ${C.borderSolid}`, paddingRight: 4 }}
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
            {/* ── Sidebar top panel ─── */}
            <div className={sidebarSplit ? "flex flex-col min-h-0 overflow-hidden" : "flex flex-col flex-1 min-h-0 overflow-hidden"}
              style={sidebarSplit ? { height: `${sidebarSplitRatio * 100}%` } : undefined}
            >
              {renderSidebarTabs(sidebarSection, setSidebarSection, true)}
              <div className="flex-1 overflow-y-auto min-h-0">
                {renderSidebarSection(sidebarSection)}
              </div>
            </div>

            {/* ── Sidebar split divider + bottom panel ─── */}
            {sidebarSplit && (
              <>
                <div
                  className="h-1 cursor-row-resize shrink-0 hover:bg-accent/30 active:bg-accent/50 transition-colors"
                  style={{ borderTop: `1px solid ${C.border}` }}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    const parent = (e.target as HTMLElement).closest("[data-sidebar-panel]")
                    if (!parent) return
                    const startY = e.clientY
                    const startRatio = sidebarSplitRatio
                    const totalH = parent.getBoundingClientRect().height
                    const onMove = (ev: MouseEvent) => {
                      const delta = ev.clientY - startY
                      const newRatio = Math.max(0.15, Math.min(0.85, startRatio + delta / totalH))
                      setIoeLayout({ sidebarSplitRatio: newRatio })
                    }
                    const onUp = () => {
                      document.removeEventListener("mousemove", onMove)
                      document.removeEventListener("mouseup", onUp)
                    }
                    document.addEventListener("mousemove", onMove)
                    document.addEventListener("mouseup", onUp)
                  }}
                />
                <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
                  {renderSidebarTabs(sidebarBottomSection, setSidebarBottomSection)}
                  <div className="flex-1 overflow-y-auto min-h-0">
                    {renderSidebarSection(sidebarBottomSection)}
                  </div>
                </div>
              </>
            )}
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
            className="flex h-9 items-center gap-2 px-3 shrink-0 text-[13px]"
            style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}
          >
            <span className="truncate flex-1" style={{ color: activeRun ? C.text : C.muted }}>
              {activeRun ? activeRun.goal : "No active run — submit a goal below"}
            </span>
            {currentIteration && (
              <span className="shrink-0 text-[13px]" style={{ color: C.dim }}>
                iter {currentIteration.current}/{currentIteration.max}
              </span>
            )}
            <div className="flex items-center gap-1 flex-wrap justify-end">
              {isRunning && <ActionBtn label="CANCEL" color={C.coral} onClick={handleCancel} />}
              {(isFailed || isCancelled || isCrashed) && <ActionBtn label="RESUME" color={C.peach} onClick={handleResume} />}
              {(activeRun?.status === RunStatus.Completed || isFailed || isCancelled || isCrashed) && (
                <ActionBtn label="RE-RUN" color={C.accent} onClick={handleRerun} />
              )}
              {pendingWorkspaceChanges > 0 && (
                <ActionBtn
                  label={applyingWorkspace ? "APPLYING" : `APPROVE${pendingWorkspaceChanges > 0 ? ` ${pendingWorkspaceChanges}` : ""}`}
                  color={C.success}
                  onClick={handleApplyWorkspace}
                />
              )}
              {(activeRun?.status === RunStatus.Completed || isFailed || isCancelled || isCrashed) && !rolledBack && (
                <ActionBtn label="ROLLBACK" color={C.warning} onClick={handleRollback} />
              )}
              {rollbackMsg && (
                <span className="text-[13px] ml-1" style={{ color: C.warning }}>{rollbackMsg}</span>
              )}
              {workspaceMsg && (
                <span className="text-[13px] ml-1" style={{ color: C.success }}>{workspaceMsg}</span>
              )}
            </div>
          </div>

          {/* Kill bar — shows executing tool calls */}
          {executingToolCalls.size > 0 && !pendingKill && (
            <div
              className="flex items-center gap-2 px-3 py-1 shrink-0 text-[12px] font-mono overflow-x-auto"
              style={{ background: "color-mix(in oklab, var(--color-error) 3%, transparent)", borderBottom: `1px solid color-mix(in oklab, var(--color-error) 12%, transparent)` }}
            >
              <span style={{ color: "var(--color-error)", opacity: 0.7 }}>EXECUTING:</span>
              {[...executingToolCalls.values()].map((tc) => (
                <button
                  key={tc.toolCallId}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded cursor-pointer transition-colors hover:brightness-125 shrink-0"
                  style={{ background: "color-mix(in oklab, var(--color-error) 8%, transparent)", color: "var(--color-error)", border: "1px solid color-mix(in oklab, var(--color-error) 19%, transparent)" }}
                  onClick={() => setPendingKill(tc)}
                  title={`Kill ${tc.toolName}`}
                >
                  <Square size={8} />
                  {tc.toolName}
                </button>
              ))}
            </div>
          )}
          {pendingKill && (
            <div
              className="flex items-center gap-2 px-3 py-1.5 shrink-0 text-[12px]"
              style={{ background: "color-mix(in oklab, var(--color-error) 6%, transparent)", borderBottom: `1px solid color-mix(in oklab, var(--color-error) 25%, transparent)` }}
            >
              <span style={{ color: "var(--color-error)" }}>Kill <span className="font-mono font-medium">{pendingKill.toolName}</span>:</span>
              <input
                type="text"
                className="flex-1 bg-transparent outline-none text-[12px] font-mono min-w-0"
                style={{ color: C.text, caretColor: "var(--color-error)" }}
                placeholder="steering message (or press Enter to skip)..."
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleKillToolCall((e.target as HTMLInputElement).value.trim())
                  }
                  if (e.key === "Escape") setPendingKill(null)
                }}
              />
              <button
                className="px-1.5 py-0.5 rounded text-[11px] cursor-pointer"
                style={{ color: "var(--color-error)", border: "1px solid color-mix(in oklab, var(--color-error) 19%, transparent)" }}
                onClick={() => setPendingKill(null)}
              >
                Cancel
              </button>
            </div>
          )}

          {/* Editor content (split or single) */}
          <div className="flex flex-1 min-h-0" style={{ background: C.base }}>
            {/* Left panel */}
            <div className="flex flex-col flex-1 min-w-0 min-h-0">
              {/* Left tab bar */}
              <div className="flex h-9 items-center shrink-0 select-none" style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
                <EditorTabs
                  current={editorTab}
                  onChange={setEditorTab}
                  trace={trace}
                  stepCount={steps.length}
                  busCount={busMessages.length}
                  helpUnread={helpUnread}
                  isAdmin={isAdmin}
                />
                <div className="flex-1" />
                {editorTab === EditorTab.LlmCalls && trace.length > 0 && (
                  <button
                    className="px-2 py-1 mr-0.5 rounded transition-colors cursor-pointer hover:bg-overlay-3"
                    style={{ color: C.dim }}
                    onClick={() => activeRunId && void exportAgentLoop(activeRunId)}
                    title="Export Agent Loop"
                  >
                    <Download size={14} />
                  </button>
                )}
                <button
                  className="px-2 py-1 mr-1 rounded transition-colors cursor-pointer hover:bg-overlay-3"
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
                  <div className="flex h-9 items-center shrink-0 select-none" style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
                    <EditorTabs
                      current={editorRightTab}
                      onChange={setEditorRightTab}
                      trace={trace}
                      stepCount={steps.length}
                      busCount={busMessages.length}
                      helpUnread={helpUnread}
                      isAdmin={isAdmin}
                    />
                    <div className="flex-1" />
                    {editorRightTab === EditorTab.LlmCalls && trace.length > 0 && (
                      <button
                        className="px-2 py-1 mr-1 rounded transition-colors cursor-pointer hover:bg-overlay-3"
                        style={{ color: C.dim }}
                        onClick={() => activeRunId && void exportAgentLoop(activeRunId)}
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
                {([BottomTab.Output, BottomTab.Audit, BottomTab.Problems]).map((tab) => (
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
                    {tab === BottomTab.Problems && problems.length > 0 && (
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
                    {([BottomTab.Output, BottomTab.Audit, BottomTab.Problems]).map((tab) => (
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
                  className="px-2 py-1 mr-1 rounded transition-colors cursor-pointer hover:bg-overlay-3"
                  style={{ color: bottomSplit ? C.text : C.dim }}
                  onClick={() => setBottomSplit(!bottomSplit)}
                  title="Split bottom panel"
                >
                  <Columns2 size={14} />
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
              className="shrink-0 flex flex-col px-3 pt-2 pb-1.5"
              style={{ borderTop: `1px solid ${C.borderSolid}`, background: C.surface }}
            >
              <div
                className="composer-input-shell overflow-hidden rounded-lg"
                style={{ border: `1px solid ${C.border}`, background: C.elevated }}
              >
              <ChatComposerShell console={cmdConsole} slashPalette={compactSlashPalette} variant="ioe" density="compact">
              <div className="flex items-center gap-2 px-2 py-1.5">
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
                className="flex-1 min-w-0 bg-transparent outline-none text-[13px]"
                style={{ color: C.text, caretColor: C.accent }}
                  placeholder={slashOnlyMode ? "Type /cancel, /trace, /status…" : "Enter goal or press / for commands"}
                  value={goalInput}
                  onChange={(e) =>
                    setGoalInput((prev) => coerceSlashOnlyInput(e.target.value, prev, slashOnlyMode))
                  }
                  onKeyDown={(e) => {
                    if (handleCompactSlashKeyDown(e)) return
                    if (e.key === "Enter") handleSubmitGoal()
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={submitting || !!pendingInput}
                />
              {liveUsage.totalTokens > 0 && (
                <span className="text-[13px] shrink-0" style={{ color: C.dim }}>
                  {fmtK(liveUsage.totalTokens)} tk
                </span>
              )}
              </div>
              </ChatComposerShell>
              </div>
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
              onGoalChange={(v) => setGoalInput((prev) => coerceSlashOnlyInput(v, prev, slashOnlyMode))}
              onSubmit={handleSubmitGoal}
              isRunning={runBusy}
              slashOnlyMode={slashOnlyMode}
              submitting={submitting}
              pendingInput={pendingInput}
              onRespond={handleRespondToInput}
              executingToolCalls={executingToolCalls}
              pendingKill={pendingKill}
              onKillToolCall={setPendingKill}
              onSubmitKill={handleKillToolCall}
              attachments={goalAttachments}
              onAttach={(files) => setGoalAttachments((prev) => [...prev, ...files])}
              onRemoveAttachment={(i) => setGoalAttachments((prev) => prev.filter((_, idx) => idx !== i))}
              currentActivity={currentActivity ?? undefined}
              streamingAnswer={streamingAnswer || undefined}
              fileInputRef={goalFileInputRef}
              commandConsole={cmdConsole}
              slashCommands={slashCommands}
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
