/**
 * AgentChat — send goals to the agent and see responses.
 *
 * The primary interaction widget: type a goal, agent executes, see the answer.
 * Supports voice input via Web Speech API (any language).
 */

import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Clock, FolderOpen, Loader2, MessageSquare, Mic, MicOff, Paperclip, Send, ShieldAlert, Square, User, X, XCircle } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../client/index"
import { AskUserPrompt } from "../components/AskUserPrompt"
import { ChatScrollProvider } from "../components/ChatScrollContext"
import { ScrollToLatestButton } from "../components/ScrollToLatestButton"
import { SmartAnswer } from "../components/SmartAnswer"
import { StickyUserGoal } from "../components/StickyUserGoal"
import { TypewriterAnswer } from "../components/TypewriterAnswer"
import { useContainerSize } from "../hooks/useContainerSize"
import { useStickToBottomScroll } from "../hooks/useStickToBottomScroll"
import { CHAT_SCROLL_HOST_ATTR, preserveScrollAnchor } from "../lib/chatScroll"
import { useComposerDraft } from "./chat/useComposerDraft"
import { ChatTableExportModal } from "./chat/ChatTableExportModal"
import { useChatSlashActions } from "./chat/useChatSlashActions"
import { coerceSlashOnlyInput } from "./chat/commands"
import { useSlashCommandInput } from "./chat/useSlashCommandInput"
import { ChatComposerShell } from "./chat/ChatComposerShell"
import { useCommandConsole } from "./chat/useCommandConsole"
import { useStore } from "../state/store"
import type { TraceEntry, WorkspaceDiff } from "../types"
import { formatMs } from "../lib/util"
import {
  formatFailureAnswerBody,
  formatRunFailureMessage,
  isUserSafeFailureAnswer,
} from "./agentchat/failureAnswer"
import { formatToolArgs, formatToolOutput, getToolDetail } from "./agentchat/toolFormat"

// Web Speech API types
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList
}
type SpeechRecognitionInstance = EventTarget & {
  lang: string
  interimResults: boolean
  continuous: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: SpeechRecognitionEvent) => void) | null
  onend: (() => void) | null
  onerror: ((e: Event & { error: string }) => void) | null
}
const SpeechRecognition = (globalThis as Record<string, unknown>)["SpeechRecognition"] as
  (new () => SpeechRecognitionInstance) | undefined ??
  (globalThis as Record<string, unknown>)["webkitSpeechRecognition"] as
  (new () => SpeechRecognitionInstance) | undefined

import { TOOL_LABELS } from "@mia/shared-types"


// ── Workspace changes card ─────────────────────────────────────────
// Rendered inline in the chat when the agent produced isolated file changes.
// Styled consistent with AskUserPrompt — same "action required" visual.
function WorkspaceChangesCard({
  runId,
  onDismiss,
}: {
  runId: string
  onDismiss: () => void
}) {
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null)
  const [applying, setApplying] = useState(false)
  const [applied, setApplied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const upsertRun = useStore((s) => s.upsertRun)

  useEffect(() => {
    api.getRunWorkspaceDiff(runId)
      .then(setDiff)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load changes"))
  }, [runId])

  async function handleApply() {
    setApplying(true)
    setError(null)
    try {
      await api.applyRunWorkspaceDiff(runId)
      upsertRun({ id: runId, pendingWorkspaceChanges: 0 })
      setApplied(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Apply failed")
      setApplying(false)
    }
  }

  if (applied) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-success/30 bg-success/5 text-base text-success">
        <CheckCircle2 size={14} className="shrink-0" />
        <span>Changes saved to workspace</span>
      </div>
    )
  }

  const total = diff?.total ?? 0
  const isCreatedOnly = diff != null && diff.added.length > 0 && diff.modified.length === 0 && diff.deleted.length === 0

  return (
    <div
      className="rounded-xl border border-success/40 bg-success/5 overflow-hidden"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <span className="relative flex shrink-0 h-2 w-2">
          <span className="relative inline-flex rounded-full h-2 w-2 bg-success" />
        </span>
        <FolderOpen size={13} className="text-success shrink-0" />
        <span className="text-base font-semibold text-success uppercase tracking-wide">
          {diff
            ? `Agent ${isCreatedOnly ? "created" : "changed"} ${total} file${total !== 1 ? "s" : ""}`
            : "Agent made file changes"}
        </span>
      </div>

      {/* File list */}
      {diff && (
        <div className="px-3 pb-2 space-y-0.5 max-h-40 overflow-y-auto">
          {diff.sourceRoot && (
            <p className="text-xs text-text-muted font-mono mb-1.5 truncate" title={diff.sourceRoot}>
              → {diff.sourceRoot}
            </p>
          )}
          {diff.added.map((f) => (
            <div key={f} className="flex items-center gap-1.5 text-xs font-mono">
              <span className="text-success shrink-0 w-3 select-none">+</span>
              <span className="text-text-secondary truncate">{f}</span>
            </div>
          ))}
          {diff.modified.map((f) => (
            <div key={f} className="flex items-center gap-1.5 text-xs font-mono">
              <span className="text-accent shrink-0 w-3 select-none">~</span>
              <span className="text-text-secondary truncate">{f}</span>
            </div>
          ))}
          {diff.deleted.map((f) => (
            <div key={f} className="flex items-center gap-1.5 text-xs font-mono">
              <span className="text-error shrink-0 w-3 select-none">−</span>
              <span className="text-text-muted line-through truncate">{f}</span>
            </div>
          ))}
        </div>
      )}

      {!diff && !error && (
        <p className="px-3 pb-2 text-xs text-text-muted">Loading changes…</p>
      )}
      {error && (
        <p className="px-3 pb-2 text-xs text-error">{error}</p>
      )}

      {/* Action buttons */}
      <div className="px-3 pb-3 flex gap-2">
        <button
          className="flex-1 px-3 py-1.5 rounded-lg bg-success hover:bg-success/80 text-text text-base font-medium transition-colors disabled:opacity-40"
          onClick={handleApply}
          disabled={applying || !diff}
        >
          {applying ? "Saving…" : "Save to workspace"}
        </button>
        <button
          className="px-3 py-1.5 rounded-lg border border-border text-base text-text-muted hover:text-text hover:border-border-strong transition-colors"
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}

export function AgentChat() {
  const [sending, setSending] = useState(false)
  const [listening, setListening] = useState(false)
  const [attachments, setAttachments] = useState<{ id: string; name: string; sizeBytes: number }[]>([])
  const cmdConsole = useCommandConsole()
  const runs = useStore((s) => s.runs)
  const activeRunId = useStore((s) => s.activeRunId)
  const setActiveRun = useStore((s) => s.setActiveRun)
  const pendingInput = useStore((s) => s.pendingInput)
  const clearPendingInput = useStore((s) => s.clearPendingInput)
  const dismissedWorkspaceDiffRunIds = useStore((s) => s.dismissedWorkspaceDiffRunIds)
  const dismissWorkspaceDiff = useStore((s) => s.dismissWorkspaceDiff)
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const { width: rootWidth } = useContainerSize(rootRef)
  const compact = rootWidth > 0 && rootWidth < 420

  const steps = useStore((s) => s.steps)
  const liveUsage = useStore((s) => s.liveUsage)
  const executingToolCalls = useStore((s) => s.executingToolCalls)
  // Per-step expand/collapse state for the inline tool list. Holds the
  // step ids the user has clicked open so they can see the FULL tool
  // input (e.g. the exact `command="…"`) and the FULL output text —
  // not just the brief one-line summary that the collapsed row shows.
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set())
  const toggleStep = useCallback((id: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const activeRun = runs.find((r) => r.id === activeRunId)
  const trace = activeRun?.trace ?? []
  const streamingAnswer = activeRun?.streamingAnswer ?? ""
  const isRunning = activeRun?.status === "pending" || activeRun?.status === "running" || activeRun?.status === "planning"
  const [scrollToRunId, setScrollToRunId] = useState<string | null>(null)

  const activeThreadId = useStore((s) => s.activeThreadId)
  const { draft: input, setDraft, clearDraft } = useComposerDraft(activeThreadId)
  const scopedRuns = useMemo(
    () => runs.filter((r) => r.threadId === activeThreadId),
    [runs, activeThreadId],
  )

  const [tableExportOpen, setTableExportOpen] = useState(false)

  const { tryDispatchSlash, slashCommands, slashOnlyMode } = useChatSlashActions({
    activeThreadId,
    runs: scopedRuns,
    runStatus: activeRun?.status,
    hasPendingInput: Boolean(pendingInput),
    onRunStarted: (runId) => {
      setActiveRun(runId)
      setScrollToRunId(runId)
    },
    console: cmdConsole.api,
    openFilePicker: () => fileInputRef.current?.click(),
    openTableExport: () => setTableExportOpen(true),
  })

  useEffect(() => {
    if (!slashOnlyMode) return
    if (input && !input.startsWith("/")) clearDraft()
    if (attachments.length > 0) setAttachments([])
  }, [slashOnlyMode, input, attachments.length, clearDraft])

  const collapseComposer = useCallback(() => {
    cmdConsole.clear()
    clearDraft()
  }, [cmdConsole, clearDraft])

  const hasResult = cmdConsole.pinnedOpen && cmdConsole.lines.length > 0
  const { palette: slashPalette, handleKeyDown: handleSlashKeyDown } = useSlashCommandInput({
    value: input,
    onChange: setDraft,
    commands: slashCommands,
    disabled: sending || !!pendingInput,
    variant: "term",
    onCollapse: collapseComposer,
    hasResult,
  })

  const {
    scrollHostRef: scrollContainerRef,
    contentRef: messagesInnerRef,
    onScroll,
    scrollToBottom,
    pauseAutoScroll,
    resumeAutoFollow,
    showJumpButton,
    stickIfFollowing,
  } = useStickToBottomScroll({
    resetKey: scrollToRunId,
    initialScroll: "none",
    followWhen: isRunning || Boolean(streamingAnswer),
  })

  const didInitialAnchorRef = useRef(false)

  // Currently-running step for progress display
  const runningStep = useMemo(() => {
    return [...steps].reverse().find((s) => s.status === "running") ?? null
  }, [steps])

  // Latest iteration from trace
  const latestIteration = useMemo(() => {
    type IterEntry = Extract<TraceEntry, { kind: "iteration" }>
    for (let i = trace.length - 1; i >= 0; i--) {
      const e = trace[i]
      if (e?.kind === "iteration") return e as IterEntry
    }
    return null
  }, [trace])

  // Elapsed timer from run start — ticks every second while running
  const [totalElapsed, setTotalElapsed] = useState(0)
  useEffect(() => {
    if (!activeRun || !isRunning) { setTotalElapsed(0); return }
    const t0 = new Date(activeRun.createdAt).getTime()
    const tick = () => setTotalElapsed(Math.floor((Date.now() - t0) / 1000))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [activeRun?.id, isRunning])

  // currentPhase — tracks what the agent is doing RIGHT NOW by scanning recent trace events.
  // Returned string is shown (1) as the "bouncing dots" label before any steps appear and
  // (2) as a persistent footer line below the step list card while the run is active.
  const currentPhase = useMemo((): string | null => {
    if (!activeRun || activeRun.status === "pending") return null
    if (activeRun.status === "planning" && trace.length === 0) return "Plan"

    // Track ended planner-pipeline steps so we can skip them when scanning backwards
    const endedSteps = new Set<string>()

    for (let i = trace.length - 1; i >= 0; i--) {
      const e = trace[i] as TraceEntry

      // Pipeline step lifecycle
      if (e.kind === "planner-step-end") { endedSteps.add(e.stepName); continue }
      if (e.kind === "planner-step-start" && !endedSteps.has(e.stepName)) {
        // Convert snake_case step name to human label: "blueprint_chess_contract" → "Generating blueprint chess contract"
        const label = String(e.stepName).replace(/_/g, " ")
        return `Generating ${label}`
      }

      // Planner repair / verification
      if (e.kind === "planner-repair-plan") return `Repairing (attempt ${e.attempt})`
      if (e.kind === "planner-verification") return "Verifying"
      if (e.kind === "planner-retry") return `Retry #${e.attempt}`
      if (e.kind === "planner-escalation") return "Escalating"
      if (e.kind === "planner-sql-quality") return e.phase === "blocked" ? "Blocking SQL query" : "Reviewing SQL query"

      // Planner pipeline phases
      if (e.kind === "planner-pipeline-start") return "Pipeline"
      if (e.kind === "planner-plan-generated") return `Plan — ${e.stepCount} step${e.stepCount !== 1 ? "s" : ""}`
      if (e.kind === "planner-generating") return "Generating plan"
      if (e.kind === "planning_preflight") return "Plan"

      // Delegation
      if (e.kind === "planner-delegation-start") return e.stepName
      if (e.kind === "delegation-start") return "Delegating"

      // Direct tool loop — use the tool label as activity hint, then stop scanning further
      if (e.kind === "tool-call") return TOOL_LABELS[e.tool] ?? e.tool
      if (e.kind === "iteration") break
    }

    if (runningStep) return TOOL_LABELS[runningStep.action] ?? runningStep.name
    return activeRun.status === "planning" ? "Planning" : null
  }, [activeRun, runningStep, trace])

  async function handleCancel() {
    if (!activeRunId) return
    try { await api.cancelRun(activeRunId) } catch (err: unknown) { console.error("[mia]", err) }
  }

  async function handleRespond(runId: string, response: string) {
    // Always call the API with the runId from the card; surface failures to
    // AskUserPrompt instead of swallowing them (which used to leave the UI
    // stuck on "waiting for agent" when the run was no longer answerable).
    try {
      await api.respondToRun(runId, response)
    } catch (err) {
      if (pendingInput?.runId === runId) clearPendingInput()
      throw err
    }
    if (pendingInput?.runId === runId) clearPendingInput()
  }

  // Cleanup recognition on unmount
  useEffect(() => {
    return () => { recognitionRef.current?.abort() }
  }, [])

  async function handleSend() {
    const goal = input.trim()
    if (!goal && attachments.length === 0) return
    if (sending) return

    if (slashOnlyMode && !goal.startsWith("/")) return

    if (goal.startsWith("/")) {
      const handled = await tryDispatchSlash(goal)
      if (handled) {
        clearDraft()
        return
      }
    }

    if (isRunning && !slashOnlyMode) return

    // attachmentIds; the agent uses list_attachments / read_attachment /
    // import_attachment to inspect or pull them into the sandbox.
    const attachmentIds = attachments.map((a) => a.id)

    setSending(true)
    clearDraft()
    setAttachments([])
    if (textareaRef.current) textareaRef.current.style.height = "auto"
    try {
      const threadId = useStore.getState().activeThreadId
      if (!threadId) throw new Error("No thread selected")
      const { runId } = await api.startRun(goal, attachmentIds, threadId)
      useStore.getState().beginOptimisticRun({
        id: runId,
        goal,
        threadId,
      })
      setScrollToRunId(runId)
      requestAnimationFrame(() => scrollToBottom("instant", { stick: true }))
    } catch (err) {
      // Surface the server error and clear any optimistic activeRun so
      // the chat doesn't get stuck on "Working" when startRun never
      // produced a runs row server-side.
      const msg = err instanceof Error ? err.message : String(err)
      console.error("Failed to start run:", err)
      cmdConsole.api.logError(`Failed to start run: ${msg}`)
      setActiveRun(null)
      setDraft(goal)
      setAttachments(attachments)
    } finally {
      setSending(false)
    }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    // Reset so the same file can be re-attached after removal.
    e.target.value = ""
    for (const file of files) {
      // The server caps uploads at 32 MiB; warn early so the user knows
      // before the round-trip if they pick something obviously too big.
      if (file.size > 32 * 1024 * 1024) {
        console.warn(`File "${file.name}" is too large (${Math.round(file.size / 1024)} KB); max 32768 KB`)
        continue
      }
      try {
        const meta = await api.uploadAttachment(file, { scope: "user_draft" })
        setAttachments((prev) => [...prev, { id: meta.id, name: meta.normalizedName, sizeBytes: meta.sizeBytes }])
      } catch (err) {
        console.error(`Upload failed for "${file.name}":`, err)
      }
    }
  }

  function removeAttachment(index: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }

  const toggleVoice = useCallback(() => {
    if (!SpeechRecognition) return

    if (listening) {
      recognitionRef.current?.stop()
      setListening(false)
      return
    }

    const recognition = new SpeechRecognition()
    recognition.interimResults = true
    recognition.continuous = false
    // Auto-detect language — empty string lets browser use device language
    recognition.lang = ""
    recognitionRef.current = recognition

    let finalTranscript = ""

    recognition.onresult = (e: SpeechRecognitionEvent) => {
      let interim = ""
      for (let i = 0; i < e.results.length; i++) {
        const result = e.results[i]
        if (result?.[0]) {
          if (result.isFinal) {
            finalTranscript += result[0].transcript
          } else {
            interim += result[0].transcript
          }
        }
      }
      setDraft(finalTranscript + interim)
    }

    recognition.onend = () => {
      setListening(false)
      recognitionRef.current = null
    }

    recognition.onerror = () => {
      setListening(false)
      recognitionRef.current = null
    }

    recognition.start()
    setListening(true)
  }, [listening])

  // Show recent runs as "conversation" (newest first regardless of store order).
  const recentRuns = useMemo(
    () =>
      [...runs]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 20),
    [runs],
  )

  useEffect(() => {
    if (recentRuns.length === 0) return
    if (didInitialAnchorRef.current) return
    didInitialAnchorRef.current = true
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollToBottom("instant", { stick: isRunning || Boolean(streamingAnswer) })
      })
    })
  }, [recentRuns.length, isRunning, streamingAnswer, scrollToBottom])

  useEffect(() => {
    if (!isRunning && !streamingAnswer) return
    stickIfFollowing()
  }, [streamingAnswer, trace.length, isRunning, stickIfFollowing])

  const jumpToLatest = useCallback(() => {
    resumeAutoFollow()
    requestAnimationFrame(() => {
      scrollToBottom("instant", { stick: isRunning || Boolean(streamingAnswer) })
    })
  }, [resumeAutoFollow, scrollToBottom, isRunning, streamingAnswer])

  return (
      <div ref={rootRef} className="flex flex-col h-full gap-2">
          <ChatScrollProvider pauseAutoScroll={pauseAutoScroll} scrollHostRef={scrollContainerRef}>
          <div className="relative flex-1 min-h-0 flex flex-col">
          {/* Messages area */}
          <div
              ref={scrollContainerRef}
              {...{ [CHAT_SCROLL_HOST_ATTR]: "" }}
              onScroll={onScroll}
              className="flex-1 overflow-y-auto min-h-0"
              style={{ overflowAnchor: "none" }}
          >
              <div ref={messagesInnerRef} className="space-y-3 py-1" style={{ overflowAnchor: "none" }}>
                  {recentRuns.length === 0 && (
                      <div className="text-text-muted text-sm text-center pt-8">
                          {/* Hi there! I'm MI:A */}
                      </div>
                  )}

                  {[...recentRuns].reverse().map((run) => (
                      <div key={run.id} className="space-y-2 rounded-lg p-2 relative">
                          <StickyUserGoal align="end" className="mb-3">
                              <div className="flex items-start gap-2 max-w-[95%]">
                                  <span className="text-text text-base bg-accent/10 rounded-xl rounded-tr-sm px-3 py-1.5 leading-relaxed">
                                      {run.goal}
                                  </span>
                                  <div className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center bg-accent/20">
                                      <User size={14} className="text-accent" />
                                  </div>
                              </div>
                          </StickyUserGoal>

                          {/* Answer (agent response) — left-aligned. User-safe failure
                messages get a distinct, smaller notice style with the run
                reference highlighted so the user can copy/share it. */}
                          {run.answer &&
                              (isUserSafeFailureAnswer(run.answer) ? (
                                  (() => {
                                      const { body, ref } = formatFailureAnswerBody(run.answer);
                                      return (
                                          <div className="flex items-start gap-2 w-full">
                                              <div className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center bg-warning/20">
                                                  <ShieldAlert
                                                      size={14}
                                                      className="text-warning"
                                                  />
                                              </div>
                                              <div className="flex-1 min-w-0 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2">
                                                  <div className="text-text text-base leading-relaxed whitespace-pre-wrap">
                                                      {body}
                                                  </div>
                                                  {ref && (
                                                      <div className="mt-2 inline-flex items-center gap-2 rounded border border-accent/40 bg-accent/10 px-2 py-1 font-mono text-base text-accent select-all">
                                                          <span className="text-accent/60">
                                                              ref
                                                          </span>
                                                          <span className="text-text">
                                                              {ref}
                                                          </span>
                                                      </div>
                                                  )}
                                              </div>
                                          </div>
                                      );
                                  })()
                              ) : (
                                  <div className="flex items-start gap-2 w-full">
                                      <div className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center bg-success/20">
                                          <MessageSquare
                                              size={14}
                                              className="text-success"
                                          />
                                      </div>
                                      <div className="flex-1 min-w-0">
                                          {run.id === activeRunId &&
                                          !runningStep &&
                                          executingToolCalls.size === 0 ? (
                                              <TypewriterAnswer
                                                  text={run.answer}
                                                  streaming={
                                                      run.status ===
                                                          "running" ||
                                                      run.status === "planning"
                                                  }
                                                  exportRunId={run.id}
                                              />
                                          ) : (
                                              <SmartAnswer text={run.answer} exportRunId={run.id} />
                                          )}
                                      </div>
                                  </div>
                              ))}

                          {/* Streaming answer — live preview while the agent is generating.
                Only shown when there are no active tool calls — during tool use
                the agent streams internal reasoning/markdown that looks garbled.
                We only reveal streaming text when the agent is in "pure answer"
                mode (no running step, no executing tool calls). */}
                          {run.id === activeRunId &&
                              !run.answer &&
                              streamingAnswer &&
                              !runningStep &&
                              executingToolCalls.size === 0 && (
                                  <div className="flex-1 min-w-0">
                                      <TypewriterAnswer
                                          text={streamingAnswer}
                                          streaming
                                          exportRunId={run.id}
                                      />
                                  </div>
                              )}

                          {/* Error */}
                          {run.error && (
                              <div className="flex items-start gap-2">
                                  <AlertCircle
                                      size={14}
                                      className="text-error shrink-0 mt-0.5"
                                  />
                                  <span className="text-error/80 text-base whitespace-pre-wrap break-words">
                                      {formatRunFailureMessage(run.error)}
                                  </span>
                              </div>
                          )}

                          {/* Post-completion tool review — for the active run, after the
                answer (or error) lands, keep the inline expandable tool list
                visible so the user can drill into each `Ran <tool>` row to
                see the FULL command/args and the FULL output, mirroring
                Copilot Chat's "Used X" disclosure. The live progress section
                below renders the same list during execution; this block
                preserves the same UX once the run has finished. */}
                          {run.id === activeRunId &&
                              steps.length > 0 &&
                              (run.status === "completed" ||
                                  run.status === "failed" ||
                                  run.status === "cancelled") && (
                                  <div className="flex items-start gap-2 w-full">
                                      <div className="flex-1 min-w-0">
                                          <div className="rounded-lg border border-border-subtle bg-elevated/20 overflow-hidden">
                                              <div className="divide-y divide-border-subtle">
                                                  {steps.map((step) => {
                                                      const isFailed =
                                                          step.status ===
                                                          "failed";
                                                      const label =
                                                          TOOL_LABELS[
                                                              step.action
                                                          ] ?? step.action;
                                                      const detail =
                                                          getToolDetail(
                                                              step.action,
                                                              step.input,
                                                          );
                                                      const duration =
                                                          step.startedAt &&
                                                          step.completedAt
                                                              ? new Date(
                                                                    step.completedAt,
                                                                ).getTime() -
                                                                new Date(
                                                                    step.startedAt,
                                                                ).getTime()
                                                              : null;
                                                      const isExpanded =
                                                          expandedSteps.has(
                                                              step.id,
                                                          );
                                                      const fullArgs =
                                                          formatToolArgs(
                                                              step.input,
                                                          );
                                                      const fullOutput =
                                                          formatToolOutput(
                                                              step.output,
                                                              step.error,
                                                          );
                                                      const canExpand =
                                                          fullArgs.length > 0 ||
                                                          fullOutput.length > 0;
                                                      return (
                                                          <div
                                                              key={`done-${step.id}`}
                                                          >
                                                              <button
                                                                  type="button"
                                                                  onClick={(
                                                                      e,
                                                                  ) => {
                                                                      e.stopPropagation();
                                                                      if (
                                                                          canExpand
                                                                      )
                                                                          preserveScrollAnchor(
                                                                              e.currentTarget,
                                                                              () => toggleStep(step.id),
                                                                              pauseAutoScroll,
                                                                          );
                                                                  }}
                                                                  disabled={
                                                                      !canExpand
                                                                  }
                                                                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left ${canExpand ? "hover:bg-overlay-1 cursor-pointer" : "cursor-default"}`}
                                                              >
                                                                  {canExpand ? (
                                                                      isExpanded ? (
                                                                          <ChevronDown
                                                                              size={
                                                                                  10
                                                                              }
                                                                              className="shrink-0 text-text-muted"
                                                                          />
                                                                      ) : (
                                                                          <ChevronRight
                                                                              size={
                                                                                  10
                                                                              }
                                                                              className="shrink-0 text-text-muted"
                                                                          />
                                                                      )
                                                                  ) : (
                                                                      <span className="w-2.5 shrink-0" />
                                                                  )}
                                                                  {isFailed ? (
                                                                      <XCircle
                                                                          size={
                                                                              12
                                                                          }
                                                                          className="shrink-0 text-error"
                                                                      />
                                                                  ) : (
                                                                      <CheckCircle2
                                                                          size={
                                                                              12
                                                                          }
                                                                          className="shrink-0 text-success/50"
                                                                      />
                                                                  )}
                                                                  <span className="text-base shrink-0 text-text-muted">
                                                                      {label}
                                                                  </span>
                                                                  {detail ? (
                                                                      <span className="font-mono text-xs text-text-muted truncate flex-1 min-w-0">
                                                                          {
                                                                              detail
                                                                          }
                                                                      </span>
                                                                  ) : (
                                                                      <span className="flex-1" />
                                                                  )}
                                                                  {duration !==
                                                                      null && (
                                                                      <span className="shrink-0 text-xs text-text-muted font-mono">
                                                                          {formatMs(
                                                                              duration,
                                                                          )}
                                                                      </span>
                                                                  )}
                                                              </button>
                                                              {isExpanded &&
                                                                  canExpand && (
                                                                      <div className="px-2.5 pb-2 pt-0.5 space-y-1.5">
                                                                          {fullArgs && (
                                                                              <div className="rounded border border-border-subtle bg-surface/40 px-2 py-1.5">
                                                                                  <pre className="text-xs font-mono text-text-secondary whitespace-pre-wrap break-all leading-snug">
                                                                                      <span className="text-accent">
                                                                                          {
                                                                                              step.action
                                                                                          }
                                                                                      </span>{" "}
                                                                                      {
                                                                                          fullArgs
                                                                                      }
                                                                                  </pre>
                                                                              </div>
                                                                          )}
                                                                          {fullOutput && (
                                                                              <div
                                                                                  className={`rounded border px-2 py-1.5 ${isFailed ? "border-error/40 bg-error/5" : "border-border-subtle bg-surface/40"}`}
                                                                              >
                                                                                  <pre
                                                                                      className={`text-xs font-mono whitespace-pre-wrap break-all leading-snug max-h-64 overflow-auto ${isFailed ? "text-error" : "text-text-secondary"}`}
                                                                                  >
                                                                                      {
                                                                                          fullOutput
                                                                                      }
                                                                                  </pre>
                                                                              </div>
                                                                          )}
                                                                      </div>
                                                                  )}
                                                          </div>
                                                      );
                                                  })}
                                              </div>
                                          </div>
                                      </div>
                                  </div>
                              )}

                          {/* Pending workspace file changes — accept/reject card (like ask_user) */}
                          {(run.pendingWorkspaceChanges ?? 0) > 0 &&
                              !dismissedWorkspaceDiffRunIds.has(run.id) && (
                                  <WorkspaceChangesCard
                                      runId={run.id}
                                      onDismiss={() =>
                                          dismissWorkspaceDiff(run.id)
                                      }
                                  />
                              )}

                          {/* Rich progress — shown while agent is working and no answer yet. */}
                          {run.id === activeRunId &&
                              (run.status === "running" ||
                                  run.status === "pending" ||
                                  run.status === "planning") &&
                              !run.answer && (
                                  <div className="flex items-start gap-2 w-full">
                                      <div className="flex-1 min-w-0 space-y-1.5">
                                          {run.status === "pending" ? (
                                              <span className="text-base text-text-muted">
                                                  Queued…
                                              </span>
                                          ) : pendingInput?.runId === run.id ? (
                                              /* ask_user is active — show the response prompt */
                                              <AskUserPrompt
                                                  question={
                                                      pendingInput.question
                                                  }
                                                  options={pendingInput.options}
                                                  sensitive={
                                                      pendingInput.sensitive
                                                  }
                                                  onSubmit={(response) => handleRespond(run.id, response)}
                                              />
                                          ) : (
                                              <>
                                                  {/* Copilot-style inline step list — shows each tool call as a
                          row with its status icon, label, and detail. Running step
                          gets a spinner + cancel; completed steps show a checkmark.
                          Matches GitHub Copilot Chat's "Used tools" inline display. */}
                                                  {steps.length > 0 ? (
                                                      <div className="rounded-lg border border-border-subtle bg-elevated/20 overflow-hidden">
                                                          <div className="divide-y divide-border-subtle">
                                                              {steps
                                                                  .slice(-8)
                                                                  .map(
                                                                      (
                                                                          step,
                                                                      ) => {
                                                                          const isRunning =
                                                                              step.status ===
                                                                              "running";
                                                                          const isFailed =
                                                                              step.status ===
                                                                              "failed";
                                                                          const label =
                                                                              TOOL_LABELS[
                                                                                  step
                                                                                      .action
                                                                              ] ??
                                                                              step.action;
                                                                          const detail =
                                                                              getToolDetail(
                                                                                  step.action,
                                                                                  step.input,
                                                                              );
                                                                          const duration =
                                                                              step.startedAt &&
                                                                              step.completedAt
                                                                                  ? new Date(
                                                                                        step.completedAt,
                                                                                    ).getTime() -
                                                                                    new Date(
                                                                                        step.startedAt,
                                                                                    ).getTime()
                                                                                  : null;
                                                                          const tc =
                                                                              isRunning
                                                                                  ? [
                                                                                        ...executingToolCalls.values(),
                                                                                    ].find(
                                                                                        (
                                                                                            t,
                                                                                        ) =>
                                                                                            t.toolName ===
                                                                                            step.action,
                                                                                    )
                                                                                  : null;
                                                                          const isExpanded =
                                                                              expandedSteps.has(
                                                                                  step.id,
                                                                              );
                                                                          const fullArgs =
                                                                              formatToolArgs(
                                                                                  step.input,
                                                                              );
                                                                          const fullOutput =
                                                                              formatToolOutput(
                                                                                  step.output,
                                                                                  step.error,
                                                                              );
                                                                          const canExpand =
                                                                              fullArgs.length >
                                                                                  0 ||
                                                                              fullOutput.length >
                                                                                  0;
                                                                          return (
                                                                              <div
                                                                                  key={
                                                                                      step.id
                                                                                  }
                                                                                  className={
                                                                                      isRunning
                                                                                          ? "bg-overlay-1"
                                                                                          : ""
                                                                                  }
                                                                              >
                                                                                  <button
                                                                                      type="button"
                                                                                      onClick={(
                                                                                          e,
                                                                                      ) => {
                                                                                          e.stopPropagation();
                                                                                          if (
                                                                                              canExpand
                                                                                          )
                                                                                              preserveScrollAnchor(
                                                                                                  e.currentTarget,
                                                                                                  () => toggleStep(step.id),
                                                                                                  pauseAutoScroll,
                                                                                              );
                                                                                      }}
                                                                                      disabled={
                                                                                          !canExpand
                                                                                      }
                                                                                      className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left ${canExpand ? "hover:bg-overlay-1 cursor-pointer" : "cursor-default"}`}
                                                                                  >
                                                                                      {/* Disclosure chevron — only when there's something to reveal */}
                                                                                      {canExpand ? (
                                                                                          isExpanded ? (
                                                                                              <ChevronDown
                                                                                                  size={
                                                                                                      10
                                                                                                  }
                                                                                                  className="shrink-0 text-text-muted"
                                                                                              />
                                                                                          ) : (
                                                                                              <ChevronRight
                                                                                                  size={
                                                                                                      10
                                                                                                  }
                                                                                                  className="shrink-0 text-text-muted"
                                                                                              />
                                                                                          )
                                                                                      ) : (
                                                                                          <span className="w-2.5 shrink-0" />
                                                                                      )}

                                                                                      {/* Status icon */}
                                                                                      {isRunning ? (
                                                                                          <Loader2
                                                                                              size={
                                                                                                  12
                                                                                              }
                                                                                              className="shrink-0 text-accent animate-spin"
                                                                                          />
                                                                                      ) : isFailed ? (
                                                                                          <XCircle
                                                                                              size={
                                                                                                  12
                                                                                              }
                                                                                              className="shrink-0 text-error"
                                                                                          />
                                                                                      ) : (
                                                                                          <CheckCircle2
                                                                                              size={
                                                                                                  12
                                                                                              }
                                                                                              className="shrink-0 text-success/50"
                                                                                          />
                                                                                      )}

                                                                                      {/* Tool label */}
                                                                                      <span
                                                                                          className={`text-base shrink-0 ${isRunning ? "text-text" : "text-text-muted"}`}
                                                                                      >
                                                                                          {
                                                                                              label
                                                                                          }
                                                                                      </span>

                                                                                      {/* Brief detail — path, query, command, etc. */}
                                                                                      {detail ? (
                                                                                          <span className="font-mono text-xs text-text-muted truncate flex-1 min-w-0">
                                                                                              {
                                                                                                  detail
                                                                                              }
                                                                                          </span>
                                                                                      ) : (
                                                                                          <span className="flex-1" />
                                                                                      )}

                                                                                      {/* Duration (completed) or cancel (running) */}
                                                                                      {duration !==
                                                                                          null &&
                                                                                          !isRunning && (
                                                                                              <span className="shrink-0 text-xs text-text-muted font-mono">
                                                                                                  {formatMs(
                                                                                                      duration,
                                                                                                  )}
                                                                                              </span>
                                                                                          )}
                                                                                      {isRunning && (
                                                                                          <span
                                                                                              role="button"
                                                                                              tabIndex={
                                                                                                  0
                                                                                              }
                                                                                              onClick={(
                                                                                                  e,
                                                                                              ) => {
                                                                                                  e.stopPropagation();
                                                                                                  if (
                                                                                                      tc
                                                                                                  ) {
                                                                                                      api.killToolCall(
                                                                                                          activeRunId!,
                                                                                                          tc.toolCallId,
                                                                                                          "Cancelled by user",
                                                                                                      ).catch(
                                                                                                          (err: unknown) => { console.error("[mia]", err) },
                                                                                                      );
                                                                                                  } else {
                                                                                                      handleCancel();
                                                                                                  }
                                                                                              }}
                                                                                              className="shrink-0 flex items-center justify-center w-5 h-5 rounded hover:bg-error/20 text-text-muted hover:text-error transition-colors"
                                                                                              title="Stop this tool call"
                                                                                          >
                                                                                              <Square
                                                                                                  size={
                                                                                                      8
                                                                                                  }
                                                                                                  fill="currentColor"
                                                                                              />
                                                                                          </span>
                                                                                      )}
                                                                                  </button>

                                                                                  {/* Expanded detail panel — full input as `key="value"` pairs
                                      and the raw tool output below. Mirrors the screenshot the
                                      user shared: clicking the leaf reveals the actual command
                                      that was dispatched and what it returned. */}
                                                                                  {isExpanded &&
                                                                                      canExpand && (
                                                                                          <div className="px-2.5 pb-2 pt-0.5 space-y-1.5">
                                                                                              {fullArgs && (
                                                                                                  <div className="rounded border border-border-subtle bg-surface/40 px-2 py-1.5">
                                                                                                      <pre className="text-xs font-mono text-text-secondary whitespace-pre-wrap break-all leading-snug">
                                                                                                          <span className="text-accent">
                                                                                                              {
                                                                                                                  step.action
                                                                                                              }
                                                                                                          </span>{" "}
                                                                                                          {
                                                                                                              fullArgs
                                                                                                          }
                                                                                                      </pre>
                                                                                                  </div>
                                                                                              )}
                                                                                              {fullOutput && (
                                                                                                  <div
                                                                                                      className={`rounded border px-2 py-1.5 ${isFailed ? "border-error/40 bg-error/5" : "border-border-subtle bg-surface/40"}`}
                                                                                                  >
                                                                                                      <pre
                                                                                                          className={`text-xs font-mono whitespace-pre-wrap break-all leading-snug max-h-64 overflow-auto ${isFailed ? "text-error" : "text-text-secondary"}`}
                                                                                                      >
                                                                                                          {
                                                                                                              fullOutput
                                                                                                          }
                                                                                                      </pre>
                                                                                                  </div>
                                                                                              )}
                                                                                          </div>
                                                                                      )}
                                                                              </div>
                                                                          );
                                                                      },
                                                                  )}
                                                          </div>
                                                      </div>
                                                  ) : (
                                                      /* No steps yet — show phase label with animated dots */
                                                      <div className="flex flex-col gap-1.5 py-1">
                                                          <div className="flex items-center gap-2">
                                                              <span className="w-1.5 h-1.5 rounded-full bg-success animate-bounce [animation-delay:0ms]" />
                                                              <span className="w-1.5 h-1.5 rounded-full bg-success animate-bounce [animation-delay:150ms]" />
                                                              <span className="w-1.5 h-1.5 rounded-full bg-success animate-bounce [animation-delay:300ms]" />
                                                              <span className="text-base text-text-muted font-mono">
                                                                  {currentPhase ??
                                                                      (run.status ===
                                                                      "planning"
                                                                          ? "Plan"
                                                                          : "Thinking")}
                                                              </span>
                                                          </div>
                                                      </div>
                                                  )}

                                                  {/* Active phase label — current pipeline step name or macro phase.
                          Shown below the step list so the user always knows WHY the
                          tool calls are happening (e.g. "Generating blueprint chess contract"). */}
                                                  {currentPhase &&
                                                      steps.length > 0 && (
                                                          <div className="flex flex-col gap-0.5">
                                                              <div className="flex items-center gap-1.5">
                                                                  <span className="relative flex shrink-0 h-1.5 w-1.5">
                                                                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-40" />
                                                                      <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-accent/60" />
                                                                  </span>
                                                                  <span className="text-xs text-text-muted font-mono truncate">
                                                                      {
                                                                          currentPhase
                                                                      }
                                                                  </span>
                                                              </div>
                                                          </div>
                                                      )}

                                                  {/* Live stats row — iteration · tokens · elapsed */}
                                                  {(latestIteration ||
                                                      liveUsage.totalTokens >
                                                          0 ||
                                                      totalElapsed > 0) && (
                                                      <div className="flex items-center gap-3 text-xs text-text-muted font-mono opacity-70 pt-0.5">
                                                          {latestIteration && (
                                                              <span>
                                                                  iter{" "}
                                                                  {
                                                                      latestIteration.current
                                                                  }
                                                                  /
                                                                  {
                                                                      latestIteration.max
                                                                  }
                                                              </span>
                                                          )}
                                                          {liveUsage.totalTokens >
                                                              0 && (
                                                              <span>
                                                                  {liveUsage.totalTokens.toLocaleString()}{" "}
                                                                  tk
                                                              </span>
                                                          )}
                                                          {liveUsage.llmCalls >
                                                              0 && (
                                                              <span>
                                                                  {
                                                                      liveUsage.llmCalls
                                                                  }{" "}
                                                                  LLM calls
                                                              </span>
                                                          )}
                                                          {totalElapsed > 0 && (
                                                              <span className="flex items-center gap-0.5">
                                                                  <Clock
                                                                      size={9}
                                                                  />
                                                                  {totalElapsed}
                                                                  s
                                                              </span>
                                                          )}
                                                      </div>
                                                  )}
                                              </>
                                          )}
                                      </div>
                                  </div>
                              )}
                      </div>
                  ))}
              </div>
          </div>

          {showJumpButton && (
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
              <div className="pointer-events-auto">
                <ScrollToLatestButton onClick={jumpToLatest} />
              </div>
            </div>
          )}
          </div>
          </ChatScrollProvider>

          {/* Input */}
          <div className="shrink-0 space-y-2">
              {/* Attachment chips */}
              {!slashOnlyMode && attachments.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                      {attachments.map((att, i) => (
                          <span
                              key={i}
                              className="flex items-center gap-1 text-sm bg-elevated text-text-secondary rounded-md pl-2 pr-1 py-0.5 max-w-[180px]"
                          >
                              <Paperclip
                                  size={10}
                                  className="shrink-0 text-accent"
                              />
                              <span className="truncate" title={att.name}>
                                  {att.name}
                              </span>
                              <button
                                  className="text-text-muted hover:text-error transition-colors ml-0.5 shrink-0"
                                  onClick={() => removeAttachment(i)}
                                  title="Remove"
                              >
                                  <X size={11} />
                              </button>
                          </span>
                      ))}
                  </div>
              )}

              <div className="composer-input-shell overflow-hidden rounded-lg border border-border bg-elevated focus-within:border-border-strong">
              <ChatComposerShell console={cmdConsole} slashPalette={slashPalette} variant="term">
              {/* Input */}
              <div className="flex items-end gap-2 p-2">
                  <textarea
                      ref={textareaRef}
                      rows={1}
                      autoComplete="off"
                      spellCheck={false}
                      className="flex-1 min-w-0 bg-transparent px-1 py-1.5 text-sm text-text placeholder:text-text-muted outline-none transition-all resize-none overflow-hidden"
                      style={{ maxHeight: "9rem" }}
                      placeholder={
                          pendingInput
                              ? "Respond in the prompt above ↑"
                              : listening
                                ? "Listening..."
                                : slashOnlyMode
                                  ? "Type /cancel, /trace, /status…"
                                  : "Enter a goal or press / for commands"
                      }
                      value={input}
                      onChange={(e) => {
                          const next = coerceSlashOnlyInput(e.target.value, input, slashOnlyMode)
                          setDraft(next);
                          const el = e.target;
                          el.style.height = "auto";
                          el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
                      }}
                      onKeyDown={(e) => {
                          if (handleSlashKeyDown(e)) return
                          if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              handleSend();
                          }
                      }}
                      disabled={sending || !!pendingInput}
                  />
                  {/* Hidden file input — triggered by Paperclip button */}
                  <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={handleFileChange}
                  />
                  {!slashOnlyMode && (
                  <button
                      className={`shrink-0 flex items-center justify-center ${compact ? "w-8 h-8" : "w-11 h-11"} bg-elevated text-text-muted hover:text-text hover:bg-elevated/80 rounded-lg transition-colors`}
                      onClick={() => fileInputRef.current?.click()}
                      title="Attach file"
                  >
                      <Paperclip size={16} />
                  </button>
                  )}
                  {SpeechRecognition && !slashOnlyMode && (
                      <button
                          className={`shrink-0 flex items-center justify-center ${compact ? "w-8 h-8" : "w-11 h-11"} rounded-lg transition-colors ${
                              listening
                                  ? "bg-error/20 text-error hover:bg-error/30"
                                  : "bg-elevated text-text-muted hover:text-text hover:bg-elevated/80"
                          }`}
                          onClick={toggleVoice}
                          title={listening ? "Stop listening" : "Voice input"}
                      >
                          {listening ? <MicOff size={16} /> : <Mic size={16} />}
                      </button>
                  )}
                  {/* Cancel (while running, no slash typed) / Send */}
                  {isRunning && !input.trimStart().startsWith("/") ? (
                      <button
                          className={`shrink-0 flex items-center justify-center ${compact ? "w-8 h-8" : "w-11 h-11"} bg-error/15 hover:bg-error/25 text-error rounded-lg transition-colors`}
                          onClick={handleCancel}
                          title="Stop agent"
                      >
                          <Square size={16} fill="currentColor" />
                      </button>
                  ) : (
                      <button
                          className={`shrink-0 flex items-center justify-center ${compact ? "w-8 h-8" : "w-11 h-11"} bg-accent hover:bg-accent-hover text-text rounded-lg transition-colors disabled:opacity-40`}
                          onClick={handleSend}
                          disabled={
                              slashOnlyMode
                                ? !input.trimStart().startsWith("/") || input.trim().length < 2 || sending
                                : (!input.trim() && attachments.length === 0) || sending || !!pendingInput
                          }
                          title="Send"
                      >
                          <Send size={16} />
                      </button>
                  )}
              </div>
              </ChatComposerShell>
              </div>
          </div>
      <ChatTableExportModal
        open={tableExportOpen}
        onClose={() => setTableExportOpen(false)}
        runs={scopedRuns}
        preferredRunId={activeRunId}
        onExported={(message) => cmdConsole.api.logSuccess(message)}
        onError={(message) => cmdConsole.api.logError(message)}
      />
      </div>
  );
}
