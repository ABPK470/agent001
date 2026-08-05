/**
 * TermChat — GitHub-style agent chat.
 *
 * Design: tokenized neutral palette (theme-driven via index.css), sophisticated
 * typography, auto-collapsing timeline that reveals the agent's work as it
 * happens. Complexity is hidden by default; every detail is one click away.
 */

import { ArrowUp, Check, ChevronDown, ChevronRight, FolderOpen, Dot, Plus, Square } from "lucide-react"
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { api } from "../client/index"
import { ThreadRunRail } from "./threads/ThreadRunRail"
import { AskUserPrompt } from "../components/AskUserPrompt"
import { AttachmentChips, type PendingAttachment } from "../components/AttachmentChips"
import { ChatScrollProvider, useChatScroll } from "../components/ChatScrollContext"
import {
  buildResponseParts,
  humanizeStepName,
  type ResponseIterationPart,
  type ResponseNarrativePart,
  type ResponsePlanPart,
  type ResponseProgressPart,
  type ResponseStepBlockPart,
  type ResponseSyncProgressPart,
  type ResponseToolPart,
  type ToolRow,
} from "../lib/events/build-chat-parts"
import { CodeBlock } from "../components/CodeBlock"
import { ToolExecutionCard } from "../components/ToolExecutionCard"
import { parseToolArgsFormatted } from "../components/tool-code-display"
import { ScrollToLatestButton } from "../components/ScrollToLatestButton"
import { VirtualList, type VirtualListHandle } from "../components/VirtualList"
import { Logo } from "../components/Logo"
import { SmartAnswer } from "../components/SmartAnswer"
import {
  formatFailureAnswerBody,
  isUserSafeFailureAnswer,
} from "./agentchat/failureAnswer"
import { STICKY_GOAL_HOME_TOP, StickyUserGoal } from "../components/StickyUserGoal"
import { TypewriterAnswer } from "../components/TypewriterAnswer"
import { RunStatus } from "../enums"
import { isCancelRaceFailureError } from "../lib/events/trace-terminal"
import { canResumeRun, isTerminalFailureStatus } from "../lib/run-actions"
import { useMe } from "../hooks/useMe"
import { useViewingAs } from "../hooks/useViewingAs"
import { ToastStack, useWidgetToasts } from "../components/useWidgetToasts"
import { useStickToBottomScroll } from "../hooks/useStickToBottomScroll"
import { CHAT_SCROLL_HOST_ATTR, isNearBottom } from "../lib/chatScroll"
import { consolidateSyncProgressStatus } from "../state/sync-trace-progress"
import { hasUsableTraceEntries, normalizeTraceWire } from "../lib/events/trace-wire"
import {
  HOME_CHAT_COLUMN_CLASS,
  HOME_CHAT_GUTTER_X_CLASS,
  HOME_CHAT_INPUT_DOCK_CLASS,
  CHAT_INPUT_PILL_CLASS,
  CHAT_INPUT_WIDGET_CLASS,
  CHAT_TRANSCRIPT_BOTTOM_PAPER_CLASS,
  chatTranscriptNearBottomThresholdPx,
  WIDGET_CHAT_INPUT_DOCK_CLASS,
  USER_GOAL_COLUMN_CLASS,
  USER_GOAL_TO_RESPONSE_GAP_CLASS,
} from "../app/chatLayout.js"
import {
  homeTranscriptColumnShellClassName,
  homeTranscriptScrollClassName,
  transcriptFadeOverlayClass,
} from "../app/chatTranscriptLayout.js"
import { useComposerDraft } from "./chat/useComposerDraft"
import { ChatTableExportModal } from "./chat/ChatTableExportModal"
import { useChatSlashActions } from "./chat/useChatSlashActions"
import { coerceSlashOnlyInput } from "./chat/commands"
import type { ChatSlashCatalogEntry } from "./chat/commands"
import { useSlashCommandInput } from "./chat/useSlashCommandInput"
import { ChatComposerShell } from "./chat/ChatComposerShell"
import { useCommandConsole } from "./chat/useCommandConsole"
import type { CommandConsoleState } from "./chat/useCommandConsole"
import { useStore, type GeneratedAttachment } from "../state/store"
import type { TraceEntry, WorkspaceDiff } from "../types"
import {
  computeGoalStuck,
  goalPinLayout,
  type GoalPinProfile,
  userGoalPinSlotClass,
  userGoalTextClass,
} from "./termchat/goalPin"
import {
  deriveActiveMilestoneLabel,
  formatDeliverableBytes,
  isOffThreadProgress,
  summarizeHistory,
  summarizeRunError,
} from "./termchat/milestone"
import { isParallelSubagentFanOut } from "./termchat/parallelFanOut"
import { ChatFoldBody } from "./termchat/ChatFoldBody"
import { operationStatusPill } from "../lib/status-callout"
import { shouldAutoOpenWorkChip } from "./termchat/workChipFold"
import { collapseResumeRunChains, resumeChainIds } from "./termchat/collapseResumeChains"
import { planRevealRunInTranscript } from "./termchat/revealRunInTranscript"

// Local cap mirrors the Fastify route limit. Larger files get a friendly
// inline error instead of round-tripping for a 413.
const ATTACH_MAX_BYTES = 32 * 1024 * 1024
const USER_GOAL_COLLAPSE_LINES = 3
/** VirtualList estimate for chat turns (measureElement refines). */
const TERMCHAT_TURN_ESTIMATE_PX = 160

function isUserGoalOverflowing(node: HTMLDivElement): boolean {
  const prevDisplay = node.style.display
  const prevOrient = node.style.webkitBoxOrient
  const prevClamp = node.style.webkitLineClamp
  const prevOverflow = node.style.overflow

  node.style.display = "-webkit-box"
  node.style.webkitBoxOrient = "vertical"
  node.style.webkitLineClamp = String(USER_GOAL_COLLAPSE_LINES)
  node.style.overflow = "hidden"

  const overflowing = node.scrollHeight > node.clientHeight + 1

  node.style.display = prevDisplay
  node.style.webkitBoxOrient = prevOrient
  node.style.webkitLineClamp = prevClamp
  node.style.overflow = prevOverflow

  return overflowing
}

function UserGoalText({ text }: { text: string }): React.ReactElement {
  const { pauseAutoScroll } = useChatScroll()
  const [expanded, setExpanded] = useState(false)
  const [collapsible, setCollapsible] = useState(false)
  const textRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const node = textRef.current
    if (!node) return

    const measure = () => {
      setCollapsible(isUserGoalOverflowing(node))
    }

    measure()

    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => measure())
      : null
    observer?.observe(node)
    window.addEventListener("resize", measure)

    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [text])

  return (
    <div className="space-y-2">
      <div
        ref={textRef}
        className="whitespace-pre-wrap break-words"
        style={collapsible && !expanded
          ? {
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: USER_GOAL_COLLAPSE_LINES,
              overflow: "hidden",
            }
          : undefined}
      >
        {text}
      </div>
      {collapsible && (
        <button
          type="button"
          onClick={() => {
            pauseAutoScroll()
            setExpanded((value) => !value)
          }}
          className="inline-peek__toggle"
          aria-expanded={expanded}
        >
          <span>{expanded ? "Show less" : "Show more"}</span>
          {expanded ? <ChevronDown size={14} strokeWidth={2} aria-hidden /> : <ChevronRight size={14} strokeWidth={2} aria-hidden />}
        </button>
      )}
    </div>
  )
}

function UserGoalBubble({
  goal,
  showUnpin,
  onUnpin,
}: {
  goal: string
  showUnpin?: boolean
  onUnpin?: () => void
}): React.ReactElement {
  // w-fit: hug the goal text (short goals must not stretch to the column).
  // max-w still caps long goals; ml-auto keeps the pill right-aligned.
  const shellClass =
    "w-fit overflow-hidden rounded-2xl border border-border-subtle bg-bubble-user text-[15px] leading-relaxed text-text shadow-[var(--shadow-bubble)]"
  const shellStyle = { boxShadow: "var(--shadow-bubble)" }
  const bodyClass = "min-w-0 px-5 py-3"
  const appendageClass =
    `flex shrink-0 items-center justify-center self-stretch ${userGoalPinSlotClass()} border-r border-border-subtle/70 bg-soft text-text-muted transition-colors hover:bg-panel-2 hover:text-text dark:border-white/8 dark:bg-black/10 dark:hover:bg-bubble-user dark:hover:text-text`

  // Unpinned: pill caps at column − pin slot (ml-auto), so the left gutter
  // stays outside the pill. Pinned: pin fills that gutter; text does not move.
  if (!showUnpin || !onUnpin) {
    return (
      <div className={`ml-auto ${shellClass} ${userGoalTextClass(false)}`} style={shellStyle}>
        <div className={bodyClass}>
          <UserGoalText text={goal} />
        </div>
      </div>
    )
  }

  return (
    <div className={`ml-auto flex max-w-full items-stretch ${shellClass}`} style={shellStyle}>
      <button
        type="button"
        onClick={onUnpin}
        className={appendageClass}
        title="Hide message"
        aria-label="Hide message"
      >
        <Dot size={15} strokeWidth={2} />
      </button>
      <div className={bodyClass}>
        <UserGoalText text={goal} />
      </div>
    </div>
  )
}

function ChatTurn({
  run,
  isActive,
  isHomeMode,
  pinProfile,
  me,
  unpinned,
  onUnpin,
  onClearUnpin,
  pendingInput,
  onRespond,
  onNotify,
  onNotifyError,
  onParallelFanOutChange,
}: {
  run: {
    id: string
    goal: string
    upn?: string | null
    displayName?: string | null
    status: string
    answer: string | null
    error: string | null
    pendingWorkspaceChanges?: number
    trace?: TraceEntry[]
    streamingAnswer?: string
  }
  isActive: boolean
  isHomeMode: boolean
  pinProfile: GoalPinProfile
  me: { upn?: string | null } | null
  unpinned: boolean
  onUnpin: (runId: string) => void
  onClearUnpin: (runId: string) => void
  pendingInput?: { runId: string; question: string; options?: string[]; sensitive?: boolean } | null
  onRespond: (runId: string, response: string) => Promise<void> | void
  onNotify?: (message: string) => void
  onNotifyError?: (message: string) => void
  onParallelFanOutChange?: (fanOut: boolean) => void
}): React.ReactElement {
  const turnRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef<HTMLDivElement>(null)
  const [isStuck, setIsStuck] = useState(false)
  const { scrollHostRef } = useChatScroll()
  const { stickyOffsetPx, topClass: pinTopClass, stuckScrollThreshold } = goalPinLayout(pinProfile)

  const pinned = !unpinned
  const showUnpin = pinned && isStuck

  useEffect(() => {
    if (!pinned) {
      setIsStuck(false)
      return
    }

    const host = scrollHostRef.current
    const sentinel = sentinelRef.current
    const sticky = stickyRef.current
    if (!host || !sentinel || !sticky) return

    const updateStuck = () => {
      const hostRect = host.getBoundingClientRect()
      const sentinelRect = sentinel.getBoundingClientRect()
      const stickyRect = sticky.getBoundingClientRect()
      setIsStuck(
        computeGoalStuck(pinProfile, { stickyOffsetPx, topClass: pinTopClass, stuckScrollThreshold }, {
          hostTop: hostRect.top,
          hostBottom: hostRect.bottom,
          scrollTop: host.scrollTop,
          sentinelBottom: sentinelRect.bottom,
          stickyTop: stickyRect.top,
          stickyBottom: stickyRect.bottom,
        }),
      )
    }

    updateStuck()
    host.addEventListener("scroll", updateStuck, { passive: true })
    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(updateStuck)
      : null
    resizeObserver?.observe(host)
    window.addEventListener("resize", updateStuck)

    return () => {
      host.removeEventListener("scroll", updateStuck)
      resizeObserver?.disconnect()
      window.removeEventListener("resize", updateStuck)
    }
  }, [pinned, scrollHostRef, pinProfile, stickyOffsetPx, stuckScrollThreshold])

  useEffect(() => {
    if (!unpinned) return
    const host = scrollHostRef.current
    const turn = turnRef.current
    if (!host || !turn) return

    let ignoreNextScroll = true

    const maybeRepin = () => {
      if (ignoreNextScroll) {
        ignoreNextScroll = false
        return
      }

      const hostRect = host.getBoundingClientRect()
      const turnRect = turn.getBoundingClientRect()

      if (turnRect.bottom < hostRect.top || turnRect.top > hostRect.bottom) {
        onClearUnpin(run.id)
        return
      }

      if (turnRect.top >= hostRect.top + stickyOffsetPx - 2) {
        onClearUnpin(run.id)
      }
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) {
          onClearUnpin(run.id)
        }
      },
      pinProfile === "widget"
        ? { root: host, threshold: 0, rootMargin: `-${stickyOffsetPx}px 0px 0px 0px` }
        : { root: host, threshold: 0 },
    )
    observer.observe(turn)
    host.addEventListener("scroll", maybeRepin, { passive: true })

    return () => {
      observer.disconnect()
      host.removeEventListener("scroll", maybeRepin)
    }
  }, [unpinned, onClearUnpin, run.id, scrollHostRef, pinProfile, stickyOffsetPx])

  const handleUnpin = () => {
    // Dismiss in place — do not sticky→flow or scroll-anchor (that yanks you to the goal).
    onUnpin(run.id)
  }

  const isOwnGoal = !run.upn || run.upn.toLowerCase() === me?.upn?.toLowerCase()

  return (
    <div
      ref={turnRef}
      data-run-id={run.id}
      className={`relative ${isHomeMode ? "pb-8" : "pb-10"}`}
    >
      <div ref={sentinelRef} data-run-goal-anchor className="h-px w-full shrink-0" aria-hidden />
      {/* flex + gap (not margin): home and widget share one rhythm; sticky
          cannot collapse this space. */}
      <div className={`flex min-w-0 flex-col ${USER_GOAL_TO_RESPONSE_GAP_CLASS}`}>
        {pinned ? (
          <StickyUserGoal
            ref={stickyRef}
            align="end"
            topClass={pinProfile === "home" ? STICKY_GOAL_HOME_TOP : pinTopClass}
            className="shrink-0"
            pinned
          >
            <div className={USER_GOAL_COLUMN_CLASS}>
              {!isOwnGoal && (
                <div className="flex flex-col items-end gap-1.5">
                  <span className="px-1.5 text-[15px] font-medium uppercase tracking-wide text-text-muted">
                    {run.displayName ?? run.upn}
                  </span>
                  <UserGoalBubble goal={run.goal} showUnpin={showUnpin} onUnpin={handleUnpin} />
                </div>
              )}
              {isOwnGoal && (
                <UserGoalBubble goal={run.goal} showUnpin={showUnpin} onUnpin={handleUnpin} />
              )}
            </div>
          </StickyUserGoal>
        ) : null}

        <div className="min-w-0">
          <RunMessage
            run={run}
            isActive={isActive}
            pendingInput={pendingInput}
            onRespond={onRespond}
            onNotify={onNotify}
            onNotifyError={onNotifyError}
            onParallelFanOutChange={isActive ? onParallelFanOutChange : undefined}
          />
        </div>
      </div>
    </div>
  )
}

// ── Trace → Timeline model ────────────────────────────────────────

function isRunActiveStatus(status: string | null | undefined): boolean {
  return status === RunStatus.Pending || status === RunStatus.Running || status === RunStatus.Planning
}


// ── Narrative target extraction ────────────────────────────────────
// Each tool call carries the JSON args the model invoked it with. We
// pull out the most user-meaningful field (file path, command, URL,
// query) so the per-iteration narrative can say *what* the agent did
// instead of a generic "I read files." For unknown shapes we return
// undefined and the narrative falls back to the verb's plural noun.

// Keys are the actual tool names emitted by the agent (e.g. `run_command`,
// `read_file`). The previous version of this map keyed on the short labels
// (`run`, `read`) and silently fell through to "used run_command" — that's
// what produced the buggy "I used run_command `python3 ...`" lines.

// ── Live milestone (parent shimmer) ──────────────────────────────
// The bottom shimmer label needs to mirror what the agent is actually
// doing *right now*, not the static planner-routing label that fired
// once at the start of the iteration ("Direct"). We pick the most
// specific signal available, in priority order:
//   1. The most recent in-flight tool call → "Reading monte-carlo.html"
//   2. An iteration block whose tools are still finishing → re-use its
//      collapsed-header summary so the parent reads as a sum of work.
//   3. A still-running PRIMARY_ACTIVITY (Plan / Generating / Verifying /
//      Direct) — but only as a fallback, since these are routing names,
//      not activity descriptions.
//   4. "Thinking" if a thinking-progress is running with no tools yet.
//   5. "Working" generic fallback so the shimmer is always meaningful.
const TOOL_PRESENT_TENSE: Record<string, string> = {
  read_file:           "Reading",
  write_file:          "Writing",
  append_file:         "Appending to",
  replace_in_file:     "Editing",
  list_directory:      "Listing",
  search_files:        "Searching",
  run_command:         "Running",
  fetch_url:           "Fetching",
  delegate:            "Delegating to",
  delegate_parallel:   "Delegating in parallel to",
  ask_user:            "Asking",
  think:               "Thinking about",
  note:                "Noting",
  search_catalog:      "Searching catalog for",
  compare_catalogs:    "Comparing catalogs of",
  inspect_definition:  "Inspecting definition of",
  discover_relationships: "Mapping relationships for",
  profile_data:        "Profiling",
  explore_mssql_schema:"Inspecting schema of",
  query_mssql:         "Querying",
  export_query_to_file:"Exporting query to",
  get_chart_specs:     "Loading chart specs for",
  sync_preview:        "Previewing sync for",
  sync_execute:        "Running sync for",
  list_sync_definitions: "Listing sync definitions",
  resolve_sync_scope:    "Resolving scope for",
  sync_diff_scan:      "Scanning diffs for",
  list_environments:   "Listing environments",
  list_attachments:    "Listing attachments",
  read_attachment:     "Reading attachment",
  import_attachment:   "Importing attachment",
  promote_attachment:  "Promoting attachment",
  record_table_verdict:"Recording verdict for",
}

function presentTenseLabel(tool: string, target?: string): string {
  const verb = TOOL_PRESENT_TENSE[tool]
  if (!verb) {
    // Unknown tool — humanize the snake_case name as a last resort.
    const human = tool.replace(/_/g, " ")
    return target ? `${human} ${target}` : human.charAt(0).toUpperCase() + human.slice(1)
  }
  return target ? `${verb} ${target}` : verb
}
void presentTenseLabel

// Patch a tool's status both at the top level AND inside any
// already-flushed iteration block. The build pass may have moved the
// tool into a block before its result event arrived (e.g. when an
// `iteration` boundary fired between tool-call and tool-result).


function ToolSyncProgressBody({
  part,
  embedded = false,
}: {
  part: ResponseSyncProgressPart
  embedded?: boolean
}) {
  const isRunning = part.status === "running"
  const isError = part.level === "error" || part.status === "error"
  const statusLine = consolidateSyncProgressStatus(part)

  return (
    <div className={embedded ? "space-y-2" : "ml-[14px] mt-2 mb-1 pl-6 space-y-2"}>
      {statusLine ? (
        isError ? (
          <pre className="chat-tool-error">{statusLine}</pre>
        ) : (
          <p
            className={[
              "text-[15px] leading-5 font-mono text-text-secondary",
              isRunning ? "activity-shimmer-tight text-text-muted" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {statusLine}
          </p>
        )
      ) : null}
      {part.sql?.preview ? (
        <CodeBlock
          code={part.sql.preview}
          lang="sql"
          unbounded
          copyIconOnly
          className="w-full max-w-full"
          label={[
            part.sql.label,
            part.sql.connection,
            part.sql.rowCount != null ? `${part.sql.rowCount} rows` : null,
          ].filter(Boolean).join(" · ")}
        />
      ) : null}
    </div>
  )
}

function ToolPill({
  row,
  syncProgress,
  isLast = false,
  isLiveRun = false,
}: {
  row: ToolRow
  syncProgress?: ResponseSyncProgressPart
  isLast?: boolean
  isLiveRun?: boolean
}) {
  const { preserveToggle } = useChatScroll()
  const isRunning = row.status === "running" && isLiveRun
  const isError = row.status === "error"
  const [open, setOpen] = useState(false)
  const summaryRef = useRef<HTMLButtonElement>(null)
  const argumentsValue = useMemo(
    () =>
      row.argsFormatted?.trim()
        ? parseToolArgsFormatted(row.argsFormatted) ?? {}
        : {},
    [row.argsFormatted],
  )
  const status = isError ? "error" : isRunning ? "running" : "done"
  // Sync trailing owns the status line — don't also dump tool-result variants.
  const resultText =
    isError || syncProgress ? null : row.details ?? null
  const errorText = isError ? row.details ?? null : null
  const showLiveSync = Boolean(syncProgress) && isRunning
  const trailing =
    open && syncProgress && !isRunning ? (
      <ToolSyncProgressBody part={syncProgress} embedded />
    ) : null

  function onOpenChange(next: boolean) {
    preserveToggle(summaryRef.current, () => setOpen(next))
  }

  return (
    <div
      className={`chat-tool-row${isLast ? " is-last" : ""}${isError ? " is-error" : ""}`}
      data-chat-expand-root=""
    >
      <ToolExecutionCard
        surface="chat"
        toolName={row.tool}
        argumentsValue={argumentsValue}
        argsFormatted={row.argsFormatted}
        resultText={resultText}
        errorText={errorText}
        status={status}
        preview={row.summary}
        open={open}
        onOpenChange={onOpenChange}
        summaryRef={summaryRef}
        trailing={trailing}
      />
      {showLiveSync && syncProgress ? (
        <div className="chat-tool__live" data-chat-expand-body="">
          <ToolSyncProgressBody part={syncProgress} embedded />
        </div>
      ) : null}
    </div>
  )
}

// One agent-loop iteration's worth of tool calls, encapsulated under a
// single collapsible header. Only the latest work chip stays open (until
// prose/answer lands); previous chips ease shut via ChatFoldBody.
function IterationBlock({
  part,
  syncByInvocation,
  isLiveRun = false,
  isLastIteration = false,
  hasNarrativeAfter = false,
}: {
  part: ResponseIterationPart
  syncByInvocation: Map<string, ResponseSyncProgressPart>
  isLiveRun?: boolean
  isLastIteration?: boolean
  hasNarrativeAfter?: boolean
}) {
  const { preserveToggle } = useChatScroll()
  const shouldStayOpen = shouldAutoOpenWorkChip(isLastIteration, hasNarrativeAfter)
  const [open, setOpen] = useState(shouldStayOpen)
  const [userToggled, setUserToggled] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (userToggled) return
    if (open === shouldStayOpen) return
    // Live auto-fold: suspend host follow + anchor so height snap does not
    // flash the whole transcript (same path as a user toggle).
    if (isLiveRun) {
      preserveToggle(buttonRef.current, () => setOpen(shouldStayOpen))
      return
    }
    setOpen(shouldStayOpen)
  }, [shouldStayOpen, userToggled, isLiveRun, open, preserveToggle])

  // Cursor / Copilot dialect: activity headers stay muted chrome even when a
  // nested tool failed — severity lives on the error payload (sheet callout).
  const headerToneClass = "text-text-faint"
  // Live auto open/close must be instant — height animation fights host
  // stick-to-bottom and shakes the transcript. Animate only after a user toggle.
  const animateFold = userToggled || !isLiveRun

  return (
    <div className="py-1.5" data-chat-expand-root="">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => preserveToggle(buttonRef.current, () => {
          setUserToggled(true)
          setOpen((v) => !v)
        })}
        className={`inline-flex max-w-full items-center gap-2 py-0.5 text-left text-[15px] leading-6 transition-colors hover:text-text-secondary ${headerToneClass}`}
      >
        <ChevronRight
          size={16}
          strokeWidth={1.5}
          className={`chat-trace-chev shrink-0${open ? " is-open" : ""}`}
          aria-hidden
        />
        <span>{part.summary}</span>
      </button>
      <ChatFoldBody
        open={open}
        animated={animateFold}
        className="mt-0.5 pl-6 chat-trace-fold ml-[5px]"
      >
        <IterationToolList
          tools={part.tools}
          syncByInvocation={syncByInvocation}
          isLiveRun={isLiveRun}
        />
      </ChatFoldBody>
    </div>
  )
}

/** Expandable plan outline — named steps, not a bare "3 steps" chip. */
function PlanBlock({ part }: { part: ResponsePlanPart }) {
  const { preserveToggle } = useChatScroll()
  const [open, setOpen] = useState(part.steps.length > 0 && part.steps.length <= 8)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const modeHint =
    part.executionMode === "parallel"
      ? "Parallel"
      : part.executionMode === "serial"
        ? "Serial"
        : part.executionMode === "guided"
          ? "Guided"
          : part.executionMode === "stop"
            ? "Blocked"
            : null

  return (
    <div className="py-1" data-chat-expand-root="">
      <button
        ref={buttonRef}
        type="button"
        onClick={() =>
          preserveToggle(buttonRef.current, () => setOpen((v) => !v))
        }
        className="inline-flex max-w-full items-center gap-2 py-0.5 text-left text-[15px] leading-6 text-text-muted transition-colors hover:text-text-secondary"
      >
        <ChevronRight
          size={16}
          strokeWidth={1.5}
          className={`chat-trace-chev shrink-0${open ? " is-open" : ""}`}
          aria-hidden
        />
        <span>Plan</span>
        <span className="text-text-faint">
          {part.stepCount} step{part.stepCount !== 1 ? "s" : ""}
          {modeHint ? ` · ${modeHint}` : ""}
        </span>
      </button>
      {open && part.steps.length > 0 && (
        <ol
          className="mt-1 ml-[0.35rem] pl-6 border-l border-border-subtle space-y-1 list-none"
          data-chat-expand-body=""
        >
          {part.steps.map((step, i) => {
            const isSubagent = step.type === "subagent_task"
            return (
              <li
                key={`${step.name}-${i}`}
                className="flex gap-2 text-[15px] leading-6 text-text-muted"
              >
                <span className="tabular-nums text-text-faint shrink-0 w-4 text-right">
                  {i + 1}.
                </span>
                <span className="min-w-0">
                  <span>{humanizeStepName(step.name)}</span>
                  {step.type && (
                    <span className="ml-1.5 text-text-faint">
                      {isSubagent ? "subagent" : step.type.replace(/_/g, " ")}
                    </span>
                  )}
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

/**
 * One planned step as parent — tools nest underneath (same fold dialect
 * as iteration blocks). This is the hierarchy Plan → Step → tools.
 */
function StepBlock({
  part,
  syncByInvocation,
  isLiveRun = false,
  keepOpen = false,
}: {
  part: ResponseStepBlockPart
  syncByInvocation: Map<string, ResponseSyncProgressPart>
  isLiveRun?: boolean
  keepOpen?: boolean
}) {
  const { preserveToggle } = useChatScroll()
  const [open, setOpen] = useState(part.hasRunning || keepOpen)
  const [userToggled, setUserToggled] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const working = Boolean(part.subagent && (part.hasRunning || part.status === "running"))

  useEffect(() => {
    if (userToggled) return
    let next: boolean | null = null
    if (part.hasRunning || keepOpen) next = true
    else if (!keepOpen && part.status !== "running") next = false
    if (next === null || open === next) return
    if (isLiveRun) {
      preserveToggle(buttonRef.current, () => setOpen(next))
      return
    }
    setOpen(next)
  }, [part.hasRunning, part.status, keepOpen, userToggled, isLiveRun, open, preserveToggle])

  const hasTools = part.tools.length > 0
  const errorBody = part.body?.trim() || ""
  const hasErrorBody = errorBody.length > 0
  const isSettled = part.status !== "running" && !part.hasRunning
  const isFailed = isSettled && hasErrorBody
  const hasBodyContent = hasTools || part.hasRunning || (hasErrorBody && !hasTools)
  const canToggle = hasTools || hasErrorBody
  const animateFold = userToggled || !isLiveRun
  // Process chrome stays muted whether running or settled — final answer is bright.
  const labelClass = "text-text-muted"

  return (
    <div className="chat-step py-1 min-w-0" data-chat-step-id={part.id} data-chat-expand-root="">
      <button
        ref={buttonRef}
        type="button"
        disabled={!canToggle}
        onClick={() => {
          if (!canToggle) return
          preserveToggle(buttonRef.current, () => {
            setUserToggled(true)
            setOpen((v) => !v)
          })
        }}
        className={[
          "chat-step__header flex max-w-full min-w-0 items-center gap-2 py-0.5 text-left text-[15px] leading-6",
          labelClass,
          canToggle ? "transition-colors hover:text-text" : "cursor-default",
        ].join(" ")}
      >
        {/*
          One fixed lead column (16px): logo while working, else chevron/dot.
          Instant swap — opacity exit flashed the glyph on every settle.
        */}
        <span className="chat-step__lead inline-flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden>
          {working ? (
            <Logo size={11} working />
          ) : canToggle ? (
            <ChevronRight
              size={16}
              strokeWidth={1.5}
              className={`chat-trace-chev${open ? " is-open" : ""}`}
            />
          ) : part.hasRunning && !part.subagent ? (
            <span className="block h-1.5 w-1.5 rounded-full chat-trace-dot--idle" />
          ) : null}
        </span>
        <span className="chat-step__title min-w-0 flex-1 truncate">
          <span>{part.title}</span>
          {isFailed ? (
            <>
              {" "}
              <span className={operationStatusPill("failed")}>Failed</span>
              {part.detail ? (
                <span className="font-normal text-text-muted"> — {part.detail}</span>
              ) : null}
            </>
          ) : part.detail ? (
            <span className="font-normal text-text-faint"> · {part.detail}</span>
          ) : null}
        </span>
      </button>
      {hasBodyContent ? (
        <ChatFoldBody
          open={open}
          animated={animateFold}
          className="mt-0.5 ml-[0.35rem] pl-6 chat-trace-fold min-w-0"
        >
          {hasErrorBody && !hasTools ? (
            <pre className="chat-tool-error my-0.5">{errorBody}</pre>
          ) : null}
          {hasTools ? (
            <IterationToolList
              tools={part.tools}
              syncByInvocation={syncByInvocation}
              isLiveRun={isLiveRun}
            />
          ) : part.hasRunning && !hasErrorBody ? (
            <div className="py-0.5 text-[15px] leading-6 text-text-faint">
              <span
                className="activity-shimmer-tight"
                style={
                  {
                    "--sa": "var(--color-text-muted)",
                    "--sd": "var(--color-text-faint)",
                  } as React.CSSProperties
                }
              >
                Starting…
              </span>
            </div>
          ) : null}
        </ChatFoldBody>
      ) : null}
    </div>
  )
}

// Tool rows stack in the transcript — one scrollport; no nested viewport.
function IterationToolList({
  tools,
  syncByInvocation,
  isLiveRun = false,
}: {
  tools: ResponseToolPart[]
  syncByInvocation: Map<string, ResponseSyncProgressPart>
  isLiveRun?: boolean
}) {
  return (
    <div className="chat-tool-list">
      {tools.map((toolPart, i) => (
        <ToolPill
          key={toolPart.id}
          row={toolPart.row}
          syncProgress={syncByInvocation.get(toolPart.id)}
          isLast={i === tools.length - 1}
          isLiveRun={isLiveRun}
        />
      ))}
    </div>
  )
}

function ProgressPill({ part }: { part: ResponseProgressPart }) {
  // Same dialect as Plan header: primary + faint meta on one line.
  // Never stack label / detail — that reads as a broken chip.
  return (
    <div className="py-1 min-w-0 text-[15px] leading-6 font-normal tracking-[-0.01em]">
      <span className="text-text-muted">{part.label}</span>
      {part.detail ? <span className="text-text-faint"> · {part.detail}</span> : null}
    </div>
  )
}

/**
 * Orchestrator verification beat — process gate, not a terminal failure.
 * Same quiet chrome as Subagent / Repair: `Check · needs work · {step}` or
 * `Checked work`. Expand for issue text. Soft chroma callouts stay for
 * true terminals (run cancelled / run failed), not mid-loop gates.
 */
function CheckBlock({ part }: { part: ResponseProgressPart }) {
  const { preserveToggle } = useChatScroll()
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const what = part.detail?.trim() || ""
  const body = part.body?.trim() || ""
  const hasBody = body.length > 0
  const labelClass =
    part.status === "running" ? "text-text-muted" : "text-text-faint"

  return (
    <div className="py-1 min-w-0" data-chat-expand-root="">
      <button
        ref={buttonRef}
        type="button"
        disabled={!hasBody}
        onClick={() => {
          if (!hasBody) return
          preserveToggle(buttonRef.current, () => setOpen((v) => !v))
        }}
        className={[
          "inline-flex max-w-full items-center gap-2 py-0.5 text-left text-[15px] leading-6",
          labelClass,
          hasBody ? "transition-colors hover:text-text-muted" : "cursor-default",
        ].join(" ")}
        aria-expanded={hasBody ? open : undefined}
      >
        {hasBody ? (
          <ChevronRight
            size={16}
            strokeWidth={1.5}
            className={`chat-trace-chev shrink-0${open ? " is-open" : ""}`}
            aria-hidden
          />
        ) : null}
        <span className="min-w-0">
          <span>{part.label}</span>
          {what ? <span className="text-text-faint"> · {what}</span> : null}
        </span>
      </button>
      {open && hasBody ? (
        <div
          className="mt-0.5 ml-[0.35rem] pl-6 border-l border-border-subtle text-[15px] leading-6 text-text-faint whitespace-pre-wrap break-words"
          data-chat-expand-body=""
        >
          {body}
        </div>
      ) : null}
    </div>
  )
}

function isVerificationProgress(part: ResponseProgressPart): boolean {
  return part.id === "verification" || part.id.startsWith("verification-")
}

function NarrativeUpdate({ part }: { part: ResponseNarrativePart }) {
  // Mid-run agent talk stays muted chrome — only the final answer is bright.
  if (part.role === "status") {
    return (
      <div
        className={`py-1 min-w-0 text-[15px] leading-6 ${
          part.tone === "error" ? "text-text-muted" : "text-text-faint"
        }`}
      >
        {part.text}
      </div>
    )
  }
  return (
    <div className="py-1.5 pr-2 text-[15px] leading-6 text-text-muted">
      <SmartAnswer text={part.text} compact />
    </div>
  )
}

function ErrorNote({ text }: { text: string }) {
  // Recoverable process notes stay muted; run terminals use ChatRunTerminalNotice.
  return (
    <div className="py-1 min-w-0 text-[15px] leading-6 text-text-muted">{text}</div>
  )
}

function ActiveMilestone({ part }: { part: ResponseProgressPart }) {
  // Retained for potential future re-use; the flat-thread refactor now
  // shows a single bottom "Working" shimmer in renderedParts instead.
  const text = part.detail ? `${part.label} — ${part.detail}` : part.label
  return (
    <div className="py-1.5 pr-2">
      <span
        className="activity-shimmer-tight text-[15px] leading-6 font-normal inline-block"
        style={{ "--sa": "var(--color-text)", "--sd": "var(--color-text-faint)" } as React.CSSProperties}
      >
        {text}
      </span>
    </div>
  )
}
void ActiveMilestone

function DetailViewport({ children }: { children: React.ReactNode }) {
  return <div className="mt-1 rounded-xl px-2 pt-3 pb-4">{children}</div>
}

function DetailViewportRows({
  parts,
}: {
  parts: Array<ResponseProgressPart | ResponseToolPart>
}) {
  return (
    <DetailViewport>
      <div className="space-y-0.5">
        {parts.map((part, index) => (
          part.kind === "progress"
            ? <ProgressPill key={`${part.id}-${index}`} part={part} />
            : <ToolPill key={`${part.id}-${index}`} row={part.row} />
        ))}
      </div>
    </DetailViewport>
  )
}


function HistoryDisclosure({
  parts,
}: {
  parts: Array<ResponseProgressPart | ResponseToolPart>
}) {
  const { preserveToggle } = useChatScroll()
  const [open, setOpen] = useState(false)
  const summary = summarizeHistory(parts)
  const buttonRef = useRef<HTMLButtonElement>(null)

  if (parts.length === 0) return null

  return (
    <div className="pt-1 pb-4" data-chat-expand-root="">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => preserveToggle(buttonRef.current, () => setOpen((value) => !value))}
        className="inline-flex max-w-full items-center gap-2 py-1 text-left text-[15px] text-text-faint hover:text-text-secondary transition-colors"
      >
        <ChevronRight
          size={16}
          strokeWidth={1.5}
          className={`chat-trace-chev shrink-0${open ? " is-open" : ""}`}
          aria-hidden
        />
        <span className="truncate">{summary}</span>
      </button>

      {open && (
        <div className="pt-0.5 pl-1" data-chat-expand-body="">
          <DetailViewportRows parts={parts} />
        </div>
      )}
    </div>
  )
}
void HistoryDisclosure

// ── Run error ─────────────────────────────────────────────────────

function formatRunTerminalTime(iso: string | null | undefined): string {
  if (!iso) return ""
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  } catch {
    return ""
  }
}

function ChatSystemDivider({
  label,
  tone = "muted",
}: {
  label: string
  tone?: "warn" | "err" | "muted"
}) {
  return (
    <div className="chat-system-divider" data-tone={tone} role="status">
      <span className="chat-system-divider__line" aria-hidden />
      <span className="chat-system-divider__label">{label}</span>
      <span className="chat-system-divider__line" aria-hidden />
    </div>
  )
}

/** Reason line under a cancel divider — always say what happened. */
function chatCancelDetail(error?: string | null): string {
  const text = error?.trim() || ""
  if (!text || /^run cancelled by user$/i.test(text)) {
    return "This operation was aborted."
  }
  return text
}

/**
 * One chat dialect for cancelled / aborted / failed runs — light and dark.
 * Horizontal rule + label, then a short reason (never theme-split callouts).
 */
function ChatRunTerminalNotice({
  kind,
  completedAt,
  detail,
}: {
  kind: "cancelled" | "failed"
  completedAt?: string | null
  detail: string
}) {
  const time = formatRunTerminalTime(completedAt)
  const label =
    kind === "cancelled"
      ? `Run cancelled${time ? ` · ${time}` : ""}`
      : `Run failed${time ? ` · ${time}` : ""}`
  return (
    <div className="chat-run-terminal">
      <ChatSystemDivider label={label} tone={kind === "cancelled" ? "warn" : "err"} />
      {detail ? <p className="chat-run-terminal__detail">{detail}</p> : null}
    </div>
  )
}

function ChatRunInterruptedBar({
  message,
  canResume,
  onResume,
  resuming,
}: {
  message: string
  canResume: boolean
  onResume: () => void
  resuming: boolean
}) {
  return (
    <div className="chat-run-interrupted-bar" role="status">
      <span className="chat-run-interrupted-bar__message">{message}</span>
      {canResume ? (
        <button
          type="button"
          onClick={onResume}
          disabled={resuming}
          className="chat-run-interrupted-bar__action"
        >
          {resuming ? "Resuming…" : "Resume run"}
        </button>
      ) : null}
    </div>
  )
}

// ── Workspace diff pill ───────────────────────────────────────────

function WorkspaceDiffCard({ runId, onNotify, onNotifyError }: {
  runId: string
  onNotify?: (message: string) => void
  onNotifyError?: (message: string) => void
}) {
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null)
  const [applying, setApplying] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [applied, setApplied] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const [open, setOpen] = useState(false)
  const upsertRun = useStore((s) => s.upsertRun)

  useEffect(() => {
    api.getRunWorkspaceDiff(runId).then(setDiff).catch((err: unknown) => { console.error("[mia]", err) })
  }, [runId])

  const downloadablePaths = diff
    ? [...diff.added, ...diff.modified]
    : []

  async function apply() {
    setApplying(true)
    try {
      await api.applyRunWorkspaceDiff(runId)
      upsertRun({ id: runId, pendingWorkspaceChanges: 0 })
      onNotify?.("Saved to workspace")
      setApplied(true)
    } catch (err) {
      onNotifyError?.(err instanceof Error ? err.message : "Apply failed")
      setApplying(false)
    }
  }

  async function saveLocally() {
    if (downloadablePaths.length === 0) return
    setDownloading(true)
    try {
      const { formatWorkspaceSaveMessage } = await import(
        "../lib/run-artifact-download.js"
      )
      const result = await api.downloadRunWorkspaceFiles(runId, downloadablePaths)
      onNotify?.(formatWorkspaceSaveMessage(result))
      setDownloaded(true)
    } catch (err) {
      const cancelled =
        (err instanceof Error && err.name === "WorkspaceSaveCancelled") ||
        (typeof err === "object" &&
          err !== null &&
          "name" in err &&
          (err as { name: string }).name === "WorkspaceSaveCancelled")
      if (cancelled) return
      onNotifyError?.(err instanceof Error ? err.message : "Download failed")
    } finally {
      setDownloading(false)
    }
  }

  const total = diff?.total ?? 0
  const hasPathContext = Boolean(diff?.executionRoot || diff?.sourceRoot)

  if (applied && !downloaded) {
    return (
      <div className="flex items-center gap-1.5 text-[15px] text-text-faint font-mono">
        <Check size={10} className="text-text-faint" />
        <span>saved to workspace</span>
      </div>
    )
  }

  if (downloaded && applied) {
    return (
      <div className="flex items-center gap-1.5 text-[15px] text-text-faint font-mono">
        <Check size={10} className="text-text-faint" />
        <span>saved locally · workspace updated</span>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-border-subtle overflow-hidden">
      <button
        type="button"
        className="flex items-center gap-2 w-full px-3 py-2 text-left"
        onClick={() => setOpen((x) => !x)}
      >
        <FolderOpen size={12} strokeWidth={1.5} className="shrink-0 text-text-faint" />
        <span className="text-[15px] text-text-muted flex-1">
          {diff ? `${total} file${total !== 1 ? "s" : ""} changed` : "File changes ready"}
        </span>
        <ChevronRight
          size={16}
          strokeWidth={1.5}
          className={`chat-trace-chev shrink-0${open ? " is-open" : ""}`}
          aria-hidden
        />
      </button>

      {open && diff && (
        <div className="px-3 pb-2 space-y-0.5 border-t border-border-subtle">
          {diff.added.map((f) => (
            <div key={f} className="flex items-center gap-1.5 text-[15px] font-mono">
              <span className="text-diff-add shrink-0">+</span>
              <span className="text-text-muted truncate">{f}</span>
            </div>
          ))}
          {diff.modified.map((f) => (
            <div key={f} className="flex items-center gap-1.5 text-[15px] font-mono">
              <span className="text-diff-add shrink-0">~</span>
              <span className="text-text-muted truncate">{f}</span>
            </div>
          ))}
          {diff.deleted.map((f) => (
            <div key={f} className="flex items-center gap-1.5 text-[15px] font-mono">
              <span className="text-diff-del shrink-0">−</span>
              <span className="text-text-faint truncate line-through">{f}</span>
            </div>
          ))}
        </div>
      )}

      {hasPathContext && (
        <div className="px-3 py-2 border-t border-border-subtle bg-overlay-1 space-y-1">
          {diff?.executionRoot && (
            <div className="text-[15px] text-text-faint font-mono break-all">
              from {diff.executionRoot}
            </div>
          )}
          {diff?.sourceRoot && (
            <div className="text-[15px] text-text-muted font-mono break-all">
              to {diff.sourceRoot}
            </div>
          )}
        </div>
      )}

      <div className="px-3 pb-2 flex gap-2 border-t border-border-subtle">
        <button
          type="button"
          className="flex-1 mt-2 px-3 py-1.5 rounded-lg border border-border bg-transparent hover:bg-overlay-hover text-[15px] text-text-muted hover:text-text-secondary transition-colors disabled:opacity-30"
          onClick={() => void saveLocally()}
          disabled={downloading || applying || downloadablePaths.length === 0}
          title="Choose a folder on your computer for these files"
        >
          {downloading ? "Saving…" : downloaded ? "Saved locally" : "Save locally"}
        </button>
        <button
          type="button"
          className="flex-1 mt-2 px-3 py-1.5 rounded-lg border border-border bg-transparent hover:bg-overlay-hover text-[15px] text-text-muted hover:text-text-secondary transition-colors disabled:opacity-30"
          onClick={() => void apply()}
          disabled={applying || downloading || !diff || applied}
          title="Merge into the project workspace"
        >
          {applying ? "Saving…" : applied ? "Saved to workspace" : "Save to workspace"}
        </button>
      </div>
    </div>
  )
}

// ── Run message block ─────────────────────────────────────────────


/**
 * Stable empty-array sentinel. MUST live at module scope (not created inline
 * in the selector) — zustand selects via `useSyncExternalStore`, and a
 * selector that returns a fresh `[]` each call makes React believe the store
 * snapshot changed between render and commit, re-rendering forever
 * ("Maximum update depth exceeded"). Returning `undefined` from the selector
 * and falling back to this constant outside it keeps the snapshot stable.
 */
const EMPTY_GENERATED_ATTACHMENTS: GeneratedAttachment[] = []

/**
 * Deliverable download chips — files the agent produced and promoted to the
 * durable attachment store (e.g. an export_query_to_file CSV). Each chip is a
 * clickable link that streams the file to the user's machine via
 * `GET /api/attachments/:id/content` (Content-Disposition: attachment). The
 * chips appear live as the agent promotes (SSE) and are reconciled on run
 * completion, so the user always has a way to reach the export that used to
 * vanish into the server sandbox.
 */
function DeliverableChips({ runId }: { runId: string }) {
  const attachments = useStore((s) => s.generatedAttachmentsByRun[runId]) ?? EMPTY_GENERATED_ATTACHMENTS
  const [busyId, setBusyId] = useState<string | null>(null)
  if (attachments.length === 0) return null
  const onDownload = async (id: string, name: string) => {
    if (busyId === id) return
    setBusyId(id)
    try {
      await api.downloadAttachment(id, name)
    } catch (err: unknown) { console.error("[mia]", err) } finally {
      setBusyId(null)
    }
  }
  return (
    <div className="pl-1 pt-1 flex flex-wrap items-center gap-1.5">
      {attachments.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => onDownload(a.id, a.name)}
          disabled={busyId === a.id}
          title={`Download ${a.name}`}
          aria-label={`Download ${a.name}`}
          className="group inline-flex items-center gap-1.5 max-w-[320px] pl-2 pr-1.5 py-1 rounded-md bg-overlay-1 border border-border-subtle text-[15px] text-text leading-none transition-colors hover:bg-overlay-2 hover:border-border disabled:opacity-50"
        >
          <FolderOpen size={12} className="shrink-0 text-text-faint group-hover:text-text" />
          <span className="truncate font-medium">{a.name}</span>
          <span className="shrink-0 text-text-faint">{formatDeliverableBytes(a.sizeBytes)}</span>
          <span className="shrink-0 text-text-faint group-hover:text-text">{busyId === a.id ? "…" : "↓"}</span>
        </button>
      ))}
    </div>
  )
}

function RunMessageImpl({
  run,
  isActive,
  pendingInput,
  onRespond,
  onNotify,
  onNotifyError,
  onParallelFanOutChange,
}: {
  run: {
    id: string
    status: string
    answer: string | null
    error: string | null
    completedAt?: string | null
    pendingWorkspaceChanges?: number
    trace?: TraceEntry[]
    streamingAnswer?: string
  }
  isActive: boolean
  pendingInput?: { runId: string; question: string; options?: string[]; sensitive?: boolean } | null
  onRespond: (runId: string, response: string) => Promise<void> | void
  onNotify?: (message: string) => void
  onNotifyError?: (message: string) => void
  /** Active turn only — pauses transcript stick-to-bottom while 2+ subagents run. */
  onParallelFanOutChange?: (fanOut: boolean) => void
}) {
  const trace = run.trace ?? []
  const liveStreamingAnswer = isActive && isRunActiveStatus(run.status) ? (run.streamingAnswer ?? "") : ""
  const responseParts = useMemo(
    () => buildResponseParts(trace, run.status, liveStreamingAnswer, run.answer, run.error, pendingInput ?? null, run.id),
    [trace, run.status, liveStreamingAnswer, run.answer, run.error, pendingInput, run.id],
  )
  const isDone = !isRunActiveStatus(run.status)
  const isLiveRun = isActive && !isDone
  const parallelFanOut = isParallelSubagentFanOut(responseParts)
  const isCancelTerminal =
    run.status === "cancelled"
    || (Boolean(run.error) && isCancelRaceFailureError(run.error) && isTerminalFailureStatus(run.status))

  useEffect(() => {
    if (!isActive) {
      onParallelFanOutChange?.(false)
      return
    }
    onParallelFanOutChange?.(parallelFanOut)
  }, [isActive, parallelFanOut, onParallelFanOutChange])

  const iterationMeta = useMemo(() => {
    const lastWorkIndex = responseParts.reduce((last, candidate, index) => {
      if (candidate.kind === "iteration-block" || candidate.kind === "step-block") return index
      return last
    }, -1)
    const meta = new Map<string, { isLastWork: boolean; hasNarrativeAfter: boolean }>()
    responseParts.forEach((candidate, index) => {
      if (candidate.kind !== "iteration-block" && candidate.kind !== "step-block") return
      meta.set(candidate.id, {
        isLastWork: index === lastWorkIndex,
        hasNarrativeAfter: responseParts.slice(index + 1).some(
          (p) =>
            (p.kind === "narrative" && p.role !== "status") ||
            p.kind === "markdown",
        ),
      })
    })
    return meta
  }, [responseParts])

  const renderedParts = useMemo(() => {
    const syncByInvocation = new Map<string, ResponseSyncProgressPart>()
    for (const part of responseParts) {
      if (part.kind === "sync-progress") syncByInvocation.set(part.invocationId, part)
    }

    // Hierarchy: Plan (outline) → Step (tools nested) → Checked work → answer.
    // Direct / Thinking / Pipeline stay off-canvas.
    const items: React.ReactNode[] = []

    let lastToolHasRunning = false
    const anySubagentRunning = responseParts.some(
      (part) => part.kind === "step-block" && part.subagent && part.hasRunning,
    )

    responseParts.forEach((part) => {
      if (part.kind === "plan") {
        items.push(<PlanBlock key={part.id} part={part} />)
        return
      }

      if (part.kind === "step-block") {
        const meta = iterationMeta.get(part.id)
        // While any subagent in this run is still live, keep every subagent
        // step open — otherwise finished siblings auto-collapse and a
        // parallel fan-out reads as one serial step at a time.
        const keepParallelSiblingsOpen =
          Boolean(part.subagent) && anySubagentRunning
        items.push(
          <StepBlock
            key={part.id}
            part={part}
            syncByInvocation={syncByInvocation}
            isLiveRun={isLiveRun}
            keepOpen={Boolean(
              part.hasRunning ||
                keepParallelSiblingsOpen ||
                (meta?.isLastWork && !meta.hasNarrativeAfter),
            )}
          />,
        )
        if (part.hasRunning) lastToolHasRunning = true
        else lastToolHasRunning = false
        return
      }

      if (part.kind === "progress") {
        if (isOffThreadProgress(part)) return
        if (isVerificationProgress(part)) {
          items.push(<CheckBlock key={part.id} part={part} />)
          return
        }
        items.push(<ProgressPill key={part.id} part={part} />)
        return
      }

      if (part.kind === "tool") {
        items.push(
          <ToolPill
            key={part.id}
            row={part.row}
            syncProgress={syncByInvocation.get(part.id)}
            isLiveRun={isLiveRun}
          />,
        )
        if (part.row.status === "running") lastToolHasRunning = true
        else lastToolHasRunning = false
        return
      }

      if (part.kind === "sync-progress") {
        return
      }

      if (part.kind === "iteration-block") {
        const meta = iterationMeta.get(part.id)
        items.push(
          <IterationBlock
            key={part.id}
            part={part}
            syncByInvocation={syncByInvocation}
            isLiveRun={isLiveRun}
            isLastIteration={meta?.isLastWork ?? false}
            hasNarrativeAfter={meta?.hasNarrativeAfter ?? false}
          />,
        )
        if (part.hasRunning) lastToolHasRunning = true
        else lastToolHasRunning = false
        return
      }

      if (part.kind === "narrative") {
        items.push(<NarrativeUpdate key={part.id} part={part} />)
        return
      }

      if (part.kind === "input") {
        items.push(
          <AskUserPrompt
            key={part.id}
            question={part.question}
            options={part.options}
            sensitive={part.sensitive}
            onSubmit={(response) => onRespond(run.id, response)}
          />,
        )
        return
      }

      if (part.kind === "markdown") {
        if (!part.streaming && isUserSafeFailureAnswer(part.text)) {
          const { body, ref } = formatFailureAnswerBody(part.text)
          items.push(
            <div
              key={part.id}
              className="py-1.5 pr-2 min-w-0 text-[15px] leading-6 text-text-muted space-y-1.5"
            >
              <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{body}</p>
              {ref ? (
                <p className="text-text-faint font-mono text-[13px] break-all">
                  Reference: {ref}
                </p>
              ) : null}
            </div>,
          )
          return
        }
        items.push(
          <TypewriterAnswer
            key={part.id}
            text={part.text}
            streaming={part.streaming === true}
            compact
            exportRunId={run.id}
          />,
        )
        return
      }

      if (part.kind === "error") {
        items.push(<ErrorNote key={part.id} text={part.text} />)
      }
    })

    // Single bottom shimmer — the persistent "we're still working"
    // milestone indicator. Shown whenever the run is active and we're
    // not already streaming the final answer. Labels + this shimmer are
    // enough; activity rows no longer carry status dots.
    const hasStreamingAnswer = responseParts.some(
      (p) => p.kind === "markdown" && p.streaming === true,
    )
    // Pick the milestone label from the most recent primary activity
    // part if any, otherwise fall back to a generic "Working".
    let milestoneLabel = deriveActiveMilestoneLabel(responseParts)
    if (isLiveRun && !hasStreamingAnswer) {
      // Suppress `lastToolHasRunning` to silence noise (avoid unused warning)
      void lastToolHasRunning
      items.push(
        <div key="active-shimmer" className="py-1.5 pr-2">
          <span
            className="activity-shimmer-tight text-[15px] leading-6 font-normal inline-block"
            style={{ "--sa": "var(--color-text-muted)", "--sd": "var(--color-text-faint)" } as React.CSSProperties}
          >
            {milestoneLabel}
          </span>
        </div>,
      )
    }

    return items
  }, [isLiveRun, iterationMeta, onRespond, responseParts, run.id])

  // Show workspace diff card when run completes with file changes
  const showDiff = isDone && (run.pendingWorkspaceChanges ?? 0) > 0

  return (
    <div className="space-y-4">
      {/* px-1 (not pl-1 only): match left/right inset so bordered answer
          chrome is not flush against the transcript's overflow-x-hidden edge. */}
      {renderedParts.length > 0 && (
        <div className="px-1 space-y-1">
          {renderedParts}
        </div>
      )}

      {/* Deliverable downloads — files the agent promoted (CSV/MD/… exports) */}
      <DeliverableChips runId={run.id} />

      {/* Terminal status — same divider dialect for light + dark, any tool/path */}
      {isCancelTerminal ? (
        <ChatRunTerminalNotice
          kind="cancelled"
          completedAt={run.completedAt}
          detail={chatCancelDetail(run.error)}
        />
      ) : null}
      {run.error && !isCancelTerminal && isTerminalFailureStatus(run.status) ? (
        <ChatRunTerminalNotice
          kind="failed"
          completedAt={run.completedAt}
          detail={summarizeRunError(run.error).summary}
        />
      ) : null}

      {/* Workspace diff */}
      {showDiff && <WorkspaceDiffCard runId={run.id} onNotify={onNotify} onNotifyError={onNotifyError} />}
    </div>
  )
}

// Memoize so completed runs don't re-render every time the active run's
// trace ticks. Active run still re-renders because its `run` reference
// changes on each batched store update.
const RunMessage = React.memo(RunMessageImpl, (prev, next) => {
  return (
    prev.run === next.run
    && prev.isActive === next.isActive
    && prev.onRespond === next.onRespond
    && prev.onNotify === next.onNotify
    && prev.onNotifyError === next.onNotifyError
    && prev.onParallelFanOutChange === next.onParallelFanOutChange
    // pendingInput only matters for the run it targets
    && (prev.pendingInput?.runId === next.pendingInput?.runId
      ? prev.pendingInput?.question === next.pendingInput?.question
      : prev.pendingInput?.runId !== next.run.id && next.pendingInput?.runId !== next.run.id)
  )
})

const FORCE_EMPTY_STATE_PREVIEW = false
/** Widget / pop-out chat column — transcript and input share the same width. */
const WIDGET_CHAT_COLUMN_CLASS = "w-full max-w-[1400px] mx-auto"

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t
}

function TermChatInputBar({
  input,
  isRunning,
  slashOnlyMode,
  slashCommands,
  commandConsole,
  pendingInput,
  sending,
  textareaRef,
  attachments,
  onChange,
  onKeyDown,
  onCancel,
  onSend,
  onAttach,
  onRemoveAttachment,
  className = "w-[90%]",
  variant = "default",
  chrome = "pill",
  heroRevealProgress = 1,
  personalReadOnly = false,
  autoFocus = false,
}: {
  input: string
  isRunning: boolean
  slashOnlyMode: boolean
  slashCommands: ChatSlashCatalogEntry[]
  commandConsole: CommandConsoleState
  pendingInput: { runId: string; question: string; options?: string[]; sensitive?: boolean } | null
  sending: boolean
  textareaRef: React.Ref<HTMLTextAreaElement>
  attachments: PendingAttachment[]
  onChange: (value: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onCancel: () => void
  onSend: () => void
  onAttach: () => void
  onRemoveAttachment: (id: string) => void
  className?: string
  variant?: "default" | "hero"
  /** `flush` = docked inside a tile that already owns the surface. Empty centered composers stay `pill`. */
  chrome?: "pill" | "flush"
  personalReadOnly?: boolean
  heroRevealProgress?: number
  /**
   * Empty-state composers may take focus. Docked composers must not — remounts
   * during a live run would yank focus off tool inspection.
   */
  autoFocus?: boolean
}) {
  const slashInput = input.trimStart().startsWith("/")
  const attachDisabled = personalReadOnly || slashOnlyMode || !!pendingInput
  const goalPlaceholder = personalReadOnly
    ? "Viewing as another user — read-only"
    : pendingInput
    ? "Respond in the prompt above ↑"
    : slashOnlyMode
      ? "Type /cancel, /trace, /status…"
      : "Enter your goal or press / for commands"
  const canSend = !personalReadOnly && (slashOnlyMode
    ? slashInput && input.trim().length > 1 && !sending
    : (Boolean(input.trim()) || attachments.length > 0) && !sending)
  const showStop = !personalReadOnly && isRunning && !slashInput
  const collapseComposer = useCallback(() => {
    commandConsole.clear()
    onChange("")
  }, [commandConsole, onChange])

  const hasResult = commandConsole.pinnedOpen && commandConsole.lines.length > 0
  const { palette, handleKeyDown: handleSlashKeyDown } = useSlashCommandInput({
    value: input,
    onChange,
    commands: slashCommands,
    disabled: !!pendingInput,
    variant: "term",
    onCollapse: collapseComposer,
    hasResult,
  })
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (handleSlashKeyDown(e)) return
    onKeyDown(e)
  }
  const isHero = variant === "hero"
  const chromeClass = chrome === "flush" ? CHAT_INPUT_WIDGET_CLASS : CHAT_INPUT_PILL_CLASS
  // heroRevealProgress is already the post-arrival handoff (0 until the
  // traveling pill has reached Last). Do not re-gate on wall-clock.
  const reveal = clamp01(heroRevealProgress)
  const heroArrived = reveal > 0.001
  const heroStyle: React.CSSProperties | undefined = isHero
    ? {
        opacity: reveal,
        visibility: heroArrived ? "visible" : "hidden",
        filter: heroArrived
          ? `blur(${lerp(3, 0, reveal).toFixed(2)}px) saturate(${lerp(0.96, 1, reveal).toFixed(3)})`
          : undefined,
        boxShadow: reveal > 0.85 ? "var(--hero-pill-shadow-live, var(--hero-pill-shadow))" : "none",
        pointerEvents: reveal < 0.08 ? "none" : undefined,
      }
    : undefined
  return (
      <div
          className={`chat-input-stack${palette ? " chat-input-stack--palette-open" : ""} ${className} mx-auto w-full min-w-0`}
      >
          {palette}
          <div
              data-intro-target="termchat-input"
              className={`chat-input-wrapper ${chromeClass} ${palette || hasResult ? "chathome-chrome-pill--composer-open" : "overflow-hidden"} ${isHero ? "rounded-[24px] px-5 py-4" : chrome === "flush" ? "rounded-none px-3 py-2.5" : "rounded-2xl px-4 py-3"}`}
              style={heroStyle}
          >
          <ChatComposerShell
            console={commandConsole}
            paletteOpen={Boolean(palette)}
            variant="term"
            density={isHero ? "hero" : "default"}
          >
          <AttachmentChips items={slashOnlyMode ? [] : attachments} onRemove={onRemoveAttachment} />
          {isHero ? (
              <div className="flex flex-col gap-3">
                  <textarea
                      ref={textareaRef}
                      value={input}
                      onChange={(e) => onChange(e.target.value)}
                      onKeyDown={handleKeyDown}
                      autoFocus={autoFocus}
                      placeholder={goalPlaceholder}
                      rows={1}
                      disabled={!!pendingInput}
                      autoComplete="off"
                      spellCheck={false}
                      className="w-full min-w-0 bg-transparent resize-none text-[15px] leading-6 text-text placeholder:text-text-faint focus:outline-none max-h-36 overflow-y-auto disabled:opacity-30"
                  />
                  <div className="flex items-center justify-between gap-3 pt-1.5">
                      <div className="flex items-center gap-1.5">
                          {!slashOnlyMode && (
                          <button
                              type="button"
                              onClick={onAttach}
                              disabled={attachDisabled}
                              title="Attach file"
                              aria-label="Attach file"
                              className="shrink-0 flex items-center justify-center w-10 h-10 rounded-xl text-text-faint hover:text-text hover:bg-overlay-2 transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-faint"
                          >
                              <Plus size={18} />
                          </button>
                          )}
                      </div>
                      {showStop ? (
                          <button
                              type="button"
                              onClick={onCancel}
                              className="shrink-0 flex items-center justify-center w-10 h-10 rounded-xl bg-policy-deny-soft hover:bg-policy-deny/20 text-policy-deny transition-colors cursor-pointer"
                              title="Stop run"
                              aria-label="Stop run"
                          >
                              <Square size={16} fill="currentColor" />
                          </button>
                      ) : (
                          <button
                              type="button"
                              onClick={onSend}
                              disabled={!canSend}
                              className="shrink-0 flex items-center justify-center w-10 h-10 rounded-xl bg-overlay-2 hover:bg-overlay-hover text-text-muted hover:text-text transition-colors disabled:opacity-30"
                              title="Send"
                          >
                              <ArrowUp size={18} />
                          </button>
                      )}
                  </div>
              </div>
          ) : (
              <div className="flex items-center gap-2">
                  {!slashOnlyMode && (
                  <button
                      type="button"
                      onClick={onAttach}
                      disabled={attachDisabled}
                      title="Attach file"
                      aria-label="Attach file"
                      className="shrink-0 flex items-center justify-center w-9 h-9 rounded-lg text-text-faint hover:text-text hover:bg-overlay-2 transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-faint"
                  >
                      <Plus size={18} />
                  </button>
                  )}
                  <textarea
                      ref={textareaRef}
                      value={input}
                      onChange={(e) => onChange(e.target.value)}
                      onKeyDown={handleKeyDown}
                      autoFocus={autoFocus}
                      placeholder={goalPlaceholder}
                      rows={1}
                      disabled={!!pendingInput}
                      autoComplete="off"
                      spellCheck={false}
                      className="flex-1 min-w-0 bg-transparent resize-none text-[15px] leading-relaxed text-text placeholder:text-text-faint focus:outline-none max-h-36 overflow-y-auto disabled:opacity-30"
                  />
                  {showStop ? (
                      <button
                          type="button"
                          onClick={onCancel}
                          className="shrink-0 flex items-center justify-center w-9 h-9 rounded-lg bg-policy-deny-soft hover:bg-policy-deny/25 text-policy-deny transition-colors cursor-pointer"
                          title="Stop run"
                          aria-label="Stop run"
                      >
                          <Square size={16} fill="currentColor" />
                      </button>
                  ) : (
                      <button
                          type="button"
                          onClick={onSend}
                          disabled={!canSend}
                          className="shrink-0 flex items-center justify-center w-9 h-9 rounded-lg bg-overlay-2 hover:bg-overlay-hover text-text-muted hover:text-text transition-colors disabled:opacity-30"
                          title="Send"
                      >
                          <ArrowUp size={18} />
                      </button>
                  )}
              </div>
          )}
          </ChatComposerShell>
          </div>
      </div>
  );
}

// ── Main widget ───────────────────────────────────────────────────

export function TermChat({
  mode = "widget",
  threadId: threadIdProp,
  heroRevealProgress = 1,
}: {
  mode?: "widget" | "home" | "thread"
  threadId?: string
  heroRevealProgress?: number
} = {}) {
  const [sending, setSending] = useState(false)
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const { toasts, dismissToast, notify, notifyError } = useWidgetToasts()
  const cmdConsole = useCommandConsole()

  const { me } = useMe()
  const { isViewingAsOther } = useViewingAs()

  const runs = useStore((s) => s.runs)
  const activeRunId = useStore((s) => s.activeRunId)
  const setActiveRun = useStore((s) => s.setActiveRun)
  const upsertRun = useStore((s) => s.upsertRun)
  const pendingInput = useStore((s) => s.pendingInput)
  const clearPendingInput = useStore((s) => s.clearPendingInput)

  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const runRailScrollSyncRef = useRef<(() => void) | null>(null)
  const virtualListRef = useRef<VirtualListHandle>(null)
  const [scrollToRunId, setScrollToRunId] = useState<string | null>(null)
  const [transcriptFadeTop, setTranscriptFadeTop] = useState(false)
  const [transcriptFadeBottom, setTranscriptFadeBottom] = useState(false)
  const [unpinnedGoalRunIds, setUnpinnedGoalRunIds] = useState<Set<string>>(() => new Set())
  /** 2+ live subagents — host stick-to-bottom would bury earlier step rows. */
  const [parallelFanOut, setParallelFanOut] = useState(false)
  const isThreadMode = mode === "thread"
  const isHomeMode = mode === "home" || isThreadMode
  const pinProfile: GoalPinProfile = mode === "widget" ? "widget" : "home"
  const activeThreadId = threadIdProp ?? useStore((s) => s.activeThreadId)
  const continuityThreadId = activeThreadId
  const { draft: input, setDraft, clearDraft } = useComposerDraft(continuityThreadId)
  const scopedActiveRunId =
    activeRunId &&
    runs.some((r) => r.id === activeRunId && r.threadId === continuityThreadId)
      ? activeRunId
      : null
  const scopedActiveRun = scopedActiveRunId
    ? runs.find((r) => r.id === scopedActiveRunId)
    : undefined
  const isRunning = isRunActiveStatus(scopedActiveRun?.status)
  const streamingAnswer = scopedActiveRun?.streamingAnswer ?? ""
  const [resumingRun, setResumingRun] = useState(false)
  /** Stick / fade slack — tracks paper height relative to the scroll host. */
  const [nearBottomThreshold, setNearBottomThreshold] = useState(
    () => chatTranscriptNearBottomThresholdPx(480),
  )

  const canResumeInterrupted = Boolean(
    scopedActiveRun && canResumeRun(scopedActiveRun.status, scopedActiveRun.hasCheckpoint),
  )

  const activeRunInterrupted = useMemo(() => {
    if (!canResumeInterrupted || !scopedActiveRun?.error) return null
    if (!isTerminalFailureStatus(scopedActiveRun.status)) return null
    return summarizeRunError(scopedActiveRun.error).summary
  }, [canResumeInterrupted, scopedActiveRun?.error, scopedActiveRun?.status])

  const resumeInterruptedRun = useCallback(async () => {
    if (!scopedActiveRunId || resumingRun) return
    setResumingRun(true)
    try {
      const { runId } = await api.resumeRun(scopedActiveRunId)
      setActiveRun(runId)
      setScrollToRunId(runId)
    } catch (err: unknown) {
      notifyError(err instanceof Error ? err.message : "Failed to resume run")
    } finally {
      setResumingRun(false)
    }
  }, [scopedActiveRunId, resumingRun, setActiveRun, notifyError])

  const scopedRuns = useMemo(
    () => runs.filter((r) => r.threadId === continuityThreadId),
    [runs, continuityThreadId],
  )

  const [tableExportOpen, setTableExportOpen] = useState(false)

  const { tryDispatchSlash, slashCommands, slashOnlyMode } = useChatSlashActions({
    activeThreadId: continuityThreadId,
    activeRunId: scopedActiveRunId,
    runs: scopedRuns,
    runStatus: scopedActiveRun?.status,
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
    if (pendingAttachments.length > 0) setPendingAttachments([])
  }, [slashOnlyMode, input, pendingAttachments.length, clearDraft])

  const {
    scrollHostRef,
    contentRef: transcriptInnerRef,
    onScroll: onTranscriptScroll,
    scrollToBottom,
    pauseAutoScroll,
    suspendAutoFollow,
    resumeAutoFollow,
    engageFollowIfNearBottom,
    showJumpButton,
  } = useStickToBottomScroll({
    resetKey: scrollToRunId,
    initialScroll: "none",
    threshold: nearBottomThreshold,
    // During parallel fan-out, stop host follow so growing sibling tools do
    // not bury earlier step headers — but never park/scroll the host for the
    // user; they stay where they were watching.
    followWhen:
      (isRunning || Boolean(scopedActiveRun?.streamingAnswer)) && !parallelFanOut,
    onScrollPosition: (scrollTop, host) => {
      if (!isHomeMode) return
      const overflows = host.scrollHeight > host.clientHeight + 1
      setTranscriptFadeTop(overflows && scrollTop > 24)
      setTranscriptFadeBottom(overflows && !isNearBottom(host, nearBottomThreshold))
    },
  })

  const syncChatNearBottomThreshold = useCallback(() => {
    const host = scrollHostRef.current
    if (!host) return
    setNearBottomThreshold(chatTranscriptNearBottomThresholdPx(host.clientHeight))
  }, [scrollHostRef])

  const handleParallelFanOutChange = useCallback((fanOut: boolean) => {
    setParallelFanOut(fanOut)
  }, [])

  useEffect(() => {
    setParallelFanOut(false)
  }, [scopedActiveRunId])

  const wasParallelFanOutRef = useRef(false)
  useEffect(() => {
    const was = wasParallelFanOutRef.current
    wasParallelFanOutRef.current = parallelFanOut
    if (was && !parallelFanOut) {
      engageFollowIfNearBottom()
    }
  }, [parallelFanOut, engageFollowIfNearBottom])

  const onTranscriptScrollWithRail = useCallback(() => {
    onTranscriptScroll()
    runRailScrollSyncRef.current?.()
  }, [onTranscriptScroll])

  // Reset the textarea to its intrinsic 1-row height when empty and to
  // its content's scrollHeight when not. Called both from the callback
  // ref (so a freshly-mounted textarea — e.g. when the empty-state ↔
  // chat-state JSX swap toggles which copy of the input bar is in the
  // tree — gets sized correctly on its very first paint) AND from the
  // input-change layout effect below (so it grows/shrinks as the user
  // types). Skipping the scrollHeight write when value is empty matters
  // because otherwise we'd lock in whatever scrollHeight the browser
  // reports for an empty textarea (varies by font load + layout context),
  // which is the root cause of the "input box is huge until F5" bug.
  const autosizeTextarea = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return
    el.style.height = "auto"
    if (el.value.length > 0) {
      el.style.height = `${el.scrollHeight}px`
    }
  }, [])

  const setTextareaRef = useCallback((el: HTMLTextAreaElement | null) => {
    textareaRef.current = el
    autosizeTextarea(el)
  }, [autosizeTextarea])

  // Auto-grow textarea as the user types. Uses useLayoutEffect so the
  // height is committed before the browser paints — no visible jump.
  useLayoutEffect(() => {
    autosizeTextarea(textareaRef.current)
  }, [input, autosizeTextarea])

  const handleInputChange = useCallback(
    (value: string) => {
      setDraft((prev) => coerceSlashOnlyInput(value, prev, slashOnlyMode))
    },
    [setDraft, slashOnlyMode],
  )

  const send = useCallback(async () => {
    if (isViewingAsOther) {
      notifyError("Viewing as another user is read-only")
      return
    }
    const goal = input.trim()
    if (!goal && pendingAttachments.length === 0) return
    if (sending) return
    if (slashOnlyMode && !goal.startsWith("/")) return

    if (goal.startsWith("/")) {
      const handled = await tryDispatchSlash(goal)
      if (handled) {
        clearDraft()
        return
      }
    }

    const effectiveGoal = goal || `Review the attached file${pendingAttachments.length === 1 ? "" : "s"}.`
    const attachmentIds = pendingAttachments.map((a) => a.id)
    clearDraft()
    setSending(true)
    try {
      const threadId = continuityThreadId
      if (!threadId) {
        throw new Error("No thread selected")
      }
      const { runId } = await useStore.getState().startRun(
        effectiveGoal,
        attachmentIds.length > 0 ? attachmentIds : undefined,
        threadId
      )
      useStore.getState().revealThreadTitleFromGoal(threadId, effectiveGoal)
      setScrollToRunId(runId)
      // Reveal is effect-driven (scrollToRunId + displayRuns) so VirtualList
      // scrollToIndex runs after the new turn is in displayRuns — not here
      // with a stale closure that only scrollHeights.
      // Only clear chips after a successful start so the user doesn't
      // lose context if the request failed mid-flight.
      setPendingAttachments([])
    } catch (e) {
      // Surface the server error and ensure the chat doesn't get stuck on
      // "Working". A failed startRun never produces a runs row, so any
      // activeRunId we may have optimistically picked up from an SSE
      // race must be cleared too.
      const msg = e instanceof Error ? e.message : String(e)
      notifyError(`Failed to start run: ${msg}`)
      setActiveRun(null)
      setDraft(effectiveGoal)
    } finally {
      setSending(false)
    }
  }, [input, sending, slashOnlyMode, setActiveRun, pendingAttachments, continuityThreadId, mode, tryDispatchSlash, clearDraft, setDraft, notifyError, isViewingAsOther])

  const cancel = useCallback(async () => {
    if (isViewingAsOther) return
    if (!scopedActiveRunId) return
    try {
      await api.cancelRun(scopedActiveRunId)
    } catch (err: unknown) {
      console.error("[mia]", err)
      notifyError(err instanceof Error ? err.message : "Failed to cancel run")
    }
  }, [scopedActiveRunId, isViewingAsOther, notifyError])

  const uploadFiles = useCallback(async (files: File[]) => {
    if (isViewingAsOther) {
      notifyError("Viewing as another user is read-only")
      return
    }
    if (files.length === 0) return
    for (const file of files) {
      if (file.size > ATTACH_MAX_BYTES) {
        notifyError(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB — max ${ATTACH_MAX_BYTES / 1024 / 1024} MB per attachment`)
        continue
      }
      try {
        const meta = await api.uploadAttachment(file)
        setPendingAttachments((prev) => [
          ...prev,
          { id: meta.id, name: meta.normalizedName, sizeBytes: meta.sizeBytes, mediaType: meta.mediaType },
        ])
      } catch (e) {
        notifyError(`Upload failed for ${file.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }, [notifyError])

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id))
    // Best-effort soft-delete; UI removal is the user's source of truth.
    void api.deleteAttachment(id).catch((err: unknown) => { console.error("[mia]", err) })
  }, [])

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleRespond = useCallback(async (runId: string, response: string) => {
    // The runId comes from the prompt card's run (the trace part), NOT from
    // the global pendingInput. This is the fix for the "Response sent —
    // waiting for agent" hang: after a reload the trace card is still
    // rendered but pendingInput is null (not persisted), so the old handler
    // early-returned and never called the API — the agent stayed blocked
    // forever. We always call the API here and let AskUserPrompt surface a
    // failure (404 = run no longer answerable) instead of a frozen "waiting".
    try {
      await api.respondToRun(runId, response)
    } catch (err) {
      if (pendingInput?.runId === runId) clearPendingInput()
      throw err
    }
    if (pendingInput?.runId === runId) clearPendingInput()
  }, [pendingInput, clearPendingInput])

  const unpinGoal = useCallback((runId: string) => {
    setUnpinnedGoalRunIds((prev) => {
      if (prev.has(runId)) return prev
      const next = new Set(prev)
      next.add(runId)
      return next
    })
  }, [])

  const clearUnpinnedGoal = useCallback((runId: string) => {
    setUnpinnedGoalRunIds((prev) => {
      if (!prev.has(runId)) return prev
      const next = new Set(prev)
      next.delete(runId)
      return next
    })
  }, [])

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  // Build message list: each "run" is a (user msg, assistant response) pair.
  // Always oldest → newest so the input bar sits under the most recent turn.
  // Approval resumes spawn child runs with the same goal — collapse those
  // chains so history is not goal → cancelled → fake "yes" × N.
  const threadRunsChronological = useMemo(() => {
    const scoped = continuityThreadId
      ? runs.filter((r) => r.threadId === continuityThreadId)
      : runs
    const sorted = [...scoped].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    )
    return collapseResumeRunChains(sorted)
  }, [runs, continuityThreadId])

  // Transcript is always oldest → newest. Selecting a run (Threads widget)
  // must not yank that run to the bottom — that reorders the chat.
  const displayRuns = threadRunsChronological

  const showEmptyState = FORCE_EMPTY_STATE_PREVIEW || displayRuns.length === 0
  const latestDisplayRunId = displayRuns.length > 0 ? displayRuns[displayRuns.length - 1]!.id : null

  useLayoutEffect(() => {
    const host = scrollHostRef.current
    if (!host || showEmptyState) return
    syncChatNearBottomThreshold()
    const ro = new ResizeObserver(syncChatNearBottomThreshold)
    ro.observe(host)
    return () => ro.disconnect()
  }, [scrollHostRef, syncChatNearBottomThreshold, showEmptyState])

  useLayoutEffect(() => {
    const host = scrollHostRef.current
    if (!host || !isHomeMode || showEmptyState) {
      setTranscriptFadeTop(false)
      setTranscriptFadeBottom(false)
      return
    }
    const overflows = host.scrollHeight > host.clientHeight + 1
    setTranscriptFadeTop(overflows && host.scrollTop > 24)
    setTranscriptFadeBottom(overflows && !isNearBottom(host, nearBottomThreshold))
  }, [
    isHomeMode,
    showEmptyState,
    displayRuns,
    scopedActiveRun?.streamingAnswer,
    scopedActiveRun?.answer,
    scrollHostRef,
    nearBottomThreshold,
  ])

  const didSelectLatestRef = useRef(false)
  const didInitialAnchorRef = useRef(false)
  const hadActiveTraceRef = useRef(false)
  const revealedScrollToRunIdRef = useRef<string | null>(null)
  const traceHydratingRef = useRef(new Set<string>())

  const hydrateRunTrace = useCallback(async (runId: string) => {
    if (runId === scopedActiveRunId) return
    const chain = resumeChainIds(runId, runs)
    for (const id of chain) {
      if (id === scopedActiveRunId) continue
      const run = runs.find((r) => r.id === id)
      if (!run || isRunActiveStatus(run.status)) continue
      // Skip only real TraceEntry[] — poisoned REST envelopes must re-fetch.
      if (hasUsableTraceEntries(run.trace)) continue
      if (traceHydratingRef.current.has(id)) continue

      traceHydratingRef.current.add(id)
      try {
        const rawTrace = await api.getRunTrace(id)
        const { entries } = normalizeTraceWire(rawTrace as unknown[])
        upsertRun({
          id,
          trace: entries,
          streamingAnswer: "",
        })
      } finally {
        traceHydratingRef.current.delete(id)
      }
    }
  }, [scopedActiveRunId, runs, upsertRun])

  // Hydrate completed run traces when their turn scrolls into view (not all at once).
  // VirtualList only mounts a window — re-observe on scroll so newly rendered roots attach.
  useEffect(() => {
    const host = scrollHostRef.current
    if (!host || displayRuns.length === 0) return
    const root = host

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const runId = (entry.target as HTMLElement).dataset.runId
          if (!runId || runId === scopedActiveRunId) continue
          const run = runs.find((r) => r.id === runId)
          if (!run || isRunActiveStatus(run.status)) continue
          if (hasUsableTraceEntries(run.trace)) continue
          void hydrateRunTrace(runId).catch((err: unknown) => { console.error("[mia]", err) })
        }
      },
      { root, rootMargin: "240px 0px", threshold: 0 },
    )

    function observeMountedTurns() {
      for (const turn of root.querySelectorAll<HTMLElement>("[data-run-id]")) {
        observer.observe(turn)
      }
    }

    observeMountedTurns()
    root.addEventListener("scroll", observeMountedTurns, { passive: true })
    return () => {
      observer.disconnect()
      root.removeEventListener("scroll", observeMountedTurns)
    }
  }, [displayRuns, scopedActiveRunId, runs, hydrateRunTrace, scrollHostRef])

  useEffect(() => {
    didSelectLatestRef.current = false
    didInitialAnchorRef.current = false
    hadActiveTraceRef.current = false
    revealedScrollToRunIdRef.current = null
  }, [me?.upn, mode, activeThreadId])

  // Same path as AgentChat: setActiveRun loads full trace + steps into the store.
  useEffect(() => {
    if (!latestDisplayRunId) return
    if (didSelectLatestRef.current) return
    const state = useStore.getState()
    const active = state.runs.find((r) => r.id === state.activeRunId)
    if (state.activeRunId && (!active || isRunActiveStatus(active.status))) {
      didSelectLatestRef.current = true
      return
    }
    didSelectLatestRef.current = true
    setActiveRun(latestDisplayRunId)
  }, [latestDisplayRunId, setActiveRun])

  useEffect(() => {
    if (displayRuns.length === 0) return
    if (didInitialAnchorRef.current) return
    didInitialAnchorRef.current = true
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollToBottom("instant", { stick: isRunning || Boolean(streamingAnswer) })
      })
    })
  }, [displayRuns.length, isRunning, streamingAnswer, scrollToBottom])

  // New goal / slash resume: VirtualList must scrollToIndex the turn. scrollHeight
  // stick alone leaves the latest turn unmounted after a tall prior run.
  useEffect(() => {
    if (!scrollToRunId) return
    if (revealedScrollToRunIdRef.current === scrollToRunId) return
    const plan = planRevealRunInTranscript(displayRuns, scrollToRunId)
    if (!plan) return
    revealedScrollToRunIdRef.current = scrollToRunId
    resumeAutoFollow()
    virtualListRef.current?.scrollToIndex(plan.index, { align: plan.align, behavior: "auto" })
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        virtualListRef.current?.scrollToIndex(plan.index, { align: plan.align, behavior: "auto" })
        scrollToBottom("instant", { stick: true })
      })
    })
  }, [scrollToRunId, displayRuns, resumeAutoFollow, scrollToBottom])

  // Re-settle once when the active run's trace first arrives from setActiveRun.
  useEffect(() => {
    if (!scopedActiveRunId || scopedActiveRunId !== latestDisplayRunId) {
      hadActiveTraceRef.current = false
      return
    }
    const traceLen = scopedActiveRun?.trace?.length ?? 0
    if (traceLen === 0) return
    if (hadActiveTraceRef.current) return
    hadActiveTraceRef.current = true
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollToBottom("instant", { stick: isRunning || Boolean(streamingAnswer) })
      })
    })
  }, [scopedActiveRunId, latestDisplayRunId, scopedActiveRun?.trace?.length, isRunning, streamingAnswer, scrollToBottom])

  // Live growth is followed by useStickToBottomScroll's ResizeObserver only.
  // Sticking again on every trace.length change double-scrolled with RO and
  // shook the transcript (same class of bug as sticking on every answer token).

  const jumpToLatest = useCallback(() => {
    resumeAutoFollow()
    if (latestDisplayRunId) {
      setActiveRun(latestDisplayRunId)
      const plan = planRevealRunInTranscript(displayRuns, latestDisplayRunId)
      if (plan) {
        virtualListRef.current?.scrollToIndex(plan.index, { align: plan.align, behavior: "auto" })
      }
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollToBottom("instant", { stick: isRunning || Boolean(streamingAnswer) })
      })
    })
  }, [latestDisplayRunId, setActiveRun, scrollToBottom, isRunning, streamingAnswer, resumeAutoFollow, displayRuns])

  const jumpToRun = useCallback((runId: string) => {
    suspendAutoFollow()
    void hydrateRunTrace(runId).catch((err: unknown) => { console.error("[mia]", err) })
    const index = displayRuns.findIndex((r) => r.id === runId)
    if (index < 0) return

    // VirtualList only mounts a window — scrollToIndex brings the turn into
    // the DOM; estimate+querySelector alone missed late runs (tall turns).
    virtualListRef.current?.scrollToIndex(index, { align: "start", behavior: "auto" })

    const settle = (): void => {
      virtualListRef.current?.scrollToIndex(index, { align: "start", behavior: "auto" })
      const host = scrollHostRef.current
      const el =
        host?.querySelector<HTMLElement>(`[data-run-id="${runId}"] [data-run-goal-anchor]`)
        ?? host?.querySelector<HTMLElement>(`[data-run-id="${runId}"]`)
      el?.scrollIntoView({ behavior: "auto", block: "start" })
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(settle)
    })
  }, [suspendAutoFollow, scrollHostRef, hydrateRunTrace, displayRuns])

  // Threads widget sets activeRunId without moving DOM order. Scroll to that
  // turn instead of reordering the transcript.
  const prevActiveForJumpRef = useRef<string | null>(null)
  useEffect(() => {
    if (!scopedActiveRunId) return
    const prev = prevActiveForJumpRef.current
    prevActiveForJumpRef.current = scopedActiveRunId
    if (!prev || prev === scopedActiveRunId) return
    if (scopedActiveRunId === latestDisplayRunId) return
    jumpToRun(scopedActiveRunId)
  }, [scopedActiveRunId, latestDisplayRunId, jumpToRun])

  // Top-to-bottom transcript order (oldest → newest).
  const threadNavRuns = useMemo(
    () => threadRunsChronological.map((run) => ({
      id: run.id,
      goal: run.goal,
      createdAt: run.createdAt,
    })),
    [threadRunsChronological],
  )

  function renderDisplayRun({ item: run }: { item: (typeof displayRuns)[number] }) {
    return (
      <ChatTurn
        run={run}
        isActive={run.id === scopedActiveRunId}
        isHomeMode={isHomeMode}
        pinProfile={pinProfile}
        me={me}
        unpinned={unpinnedGoalRunIds.has(run.id)}
        onUnpin={unpinGoal}
        onClearUnpin={clearUnpinnedGoal}
        pendingInput={pendingInput}
        onRespond={handleRespond}
        onNotify={notify}
        onNotifyError={notifyError}
        onParallelFanOutChange={handleParallelFanOutChange}
      />
    )
  }

  return (
    <div
      className={`termchat-home-shell relative bg-transparent text-text font-sans${mode === "widget" ? " termchat-widget" : ""}${isHomeMode ? " termchat-home-mode" : ""}`}
      onDragEnter={(e) => {
        if (e.dataTransfer?.types.includes("Files")) {
          e.preventDefault()
          setDragOver(true)
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes("Files")) {
          e.preventDefault()
          e.dataTransfer.dropEffect = "copy"
        }
      }}
      onDragLeave={(e) => {
        // Only clear when the drag actually leaves the shell — child
        // boundaries fire dragleave too and would otherwise flicker.
        if (e.currentTarget === e.target) setDragOver(false)
      }}
      onDrop={(e) => {
        if (!e.dataTransfer?.types.includes("Files")) return
        e.preventDefault()
        setDragOver(false)
        const files = Array.from(e.dataTransfer.files)
        if (files.length > 0) void uploadFiles(files).catch((err: unknown) => { console.error("[mia]", err) })
      }}
    >
      {/* Hidden picker — opened by the paperclip button in the input bar. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length > 0) void uploadFiles(files).catch((err: unknown) => { console.error("[mia]", err) })
          // Reset so re-selecting the same file still fires onChange.
          e.target.value = ""
        }}
      />

      {dragOver && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none rounded-md border-2 border-dashed border-accent bg-accent/10 backdrop-blur-[1px]"
        >
          <div className="px-4 py-2 rounded-lg bg-panel-2 border border-border text-text text-[14px] font-medium shadow-lg">
            Drop to attach
          </div>
        </div>
      )}

      {/* Message list */}
      <ChatScrollProvider
        pauseAutoScroll={pauseAutoScroll}
        resumeAutoFollow={resumeAutoFollow}
        engageFollowIfNearBottom={engageFollowIfNearBottom}
        suspendAutoFollow={suspendAutoFollow}
        scrollHostRef={scrollHostRef}
      >
      <div className="termchat-transcript-shell relative">
      {isThreadMode && !showEmptyState && (
        <ThreadRunRail
          runs={threadNavRuns}
          onSelectRun={jumpToRun}
          scrollHostRef={scrollHostRef}
          contentRef={transcriptInnerRef}
          scrollSyncRef={runRailScrollSyncRef}
        />
      )}
      <div
        className={
          isHomeMode
            ? `flex min-h-0 flex-1 flex-col ${
                showEmptyState ? `${HOME_CHAT_GUTTER_X_CLASS} pt-8 pb-10` : `${HOME_CHAT_GUTTER_X_CLASS} pt-0`
              }`
            : showEmptyState
              ? "flex min-h-0 flex-1 flex-col"
              : "flex min-h-0 flex-1 flex-col widget-content-gutter py-3 sm:py-4"
        }
      >
      {isHomeMode ? (
        <div className={homeTranscriptColumnShellClassName()}>
          {transcriptFadeTop && (
            <div className={transcriptFadeOverlayClass("top")} aria-hidden />
          )}
          <div
            ref={scrollHostRef}
            {...{ [CHAT_SCROLL_HOST_ATTR]: "" }}
            onScroll={onTranscriptScrollWithRail}
            className={homeTranscriptScrollClassName()}
            style={{ overflowAnchor: "none" }}
          >
            <div
              ref={transcriptInnerRef}
              className={
                showEmptyState
                  ? "min-h-full flex flex-col justify-center pb-[10vh]"
                  : "relative"
              }
              style={{ overflowAnchor: "none" }}
            >
              {showEmptyState && (
                <div className={`chathome-empty-state relative flex flex-col items-center justify-center px-6 text-center ${isHomeMode ? "min-h-[68vh]" : "min-h-[58vh]"}`}>
                  {isHomeMode && (
                    <div
                      aria-hidden="true"
                      className="chathome-empty-spotlight pointer-events-none absolute inset-x-0 top-1/2 h-[360px] -translate-y-[16%]"
                    />
                  )}
                  <div className={`relative z-10 w-full ${isHomeMode ? "space-y-8" : "max-w-[860px] space-y-8"}`}>
                    <div className={`chathome-empty-copy ${isHomeMode ? "space-y-3" : "space-y-2"}`}>
                      <p className={isHomeMode ? "text-[clamp(1.8rem,3.8vw,3.1rem)] leading-[1.02] tracking-[-0.04em] text-text font-medium" : "text-[24px] leading-tight tracking-[-0.02em] text-text font-medium"}>
                        {isThreadMode ? "Start a new thread" : isHomeMode ? "How can I help?" : "What are you working on?"}
                      </p>
                      <p className={isHomeMode ? "text-[14px] leading-6 text-text-muted max-w-[580px] mx-auto" : "text-[13px] leading-5 text-text-muted max-w-[520px] mx-auto"}>
                        {isHomeMode || isThreadMode
                          ? "Start with a goal, question, or task."
                          : "Query business data, inspect metadata or run environment synchronization."}
                      </p>
                    </div>
                    <div className="chathome-empty-input">
                      <TermChatInputBar
                        input={input}
                        isRunning={isRunning}
                        slashOnlyMode={slashOnlyMode}
                        slashCommands={slashCommands}
                        commandConsole={cmdConsole}
                        pendingInput={pendingInput}
                        sending={sending}
                        textareaRef={setTextareaRef}
                        attachments={pendingAttachments}
                        onChange={handleInputChange}
                        onKeyDown={onKey}
                        onCancel={cancel}
                        onSend={send}
                        personalReadOnly={isViewingAsOther}
                        onAttach={openFilePicker}
                        onRemoveAttachment={removeAttachment}
                        className={isHomeMode ? "w-full" : "w-full max-w-[860px]"}
                        variant={isHomeMode ? "hero" : "default"}
                        heroRevealProgress={heroRevealProgress}
                        autoFocus
                      />
                    </div>
                  </div>
                </div>
              )}

              {!showEmptyState && (
                <>
                  <VirtualList
                    ref={virtualListRef}
                    items={displayRuns}
                    scrollRef={scrollHostRef}
                    estimateSize={() => TERMCHAT_TURN_ESTIMATE_PX}
                    getItemKey={(_i, run) => run.id}
                    overscan={6}
                    adjustScrollOnResize={false}
                    renderItem={renderDisplayRun}
                  />
                  <div className={CHAT_TRANSCRIPT_BOTTOM_PAPER_CLASS} aria-hidden />
                </>
              )}
            </div>
          </div>
          {transcriptFadeBottom && (
            <div className={transcriptFadeOverlayClass("bottom")} aria-hidden />
          )}
        </div>
      ) : showEmptyState ? (
        <div
          ref={scrollHostRef}
          {...{ [CHAT_SCROLL_HOST_ATTR]: "" }}
          className="termchat-widget-empty relative flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <div
            ref={transcriptInnerRef}
            className="termchat-widget-empty__stage flex min-h-0 flex-1 flex-col items-center justify-center px-4 py-4 text-center sm:px-6 sm:py-5"
          >
            <div className="termchat-widget-empty__body chathome-empty-state relative z-10 w-full">
              <div className="chathome-empty-copy termchat-widget-empty__copy">
                <p className="termchat-widget-empty__title text-text font-medium tracking-[-0.02em]">
                  What are you working on?
                </p>
                <p className="termchat-widget-empty__detail text-text-muted mx-auto">
                  Query business data, inspect metadata or run environment synchronization.
                </p>
              </div>
              <div className="chathome-empty-input termchat-widget-empty__input">
                <TermChatInputBar
                  input={input}
                  isRunning={isRunning}
                  slashOnlyMode={slashOnlyMode}
                  slashCommands={slashCommands}
                  commandConsole={cmdConsole}
                  pendingInput={pendingInput}
                  sending={sending}
                  textareaRef={setTextareaRef}
                  attachments={pendingAttachments}
                  onChange={handleInputChange}
                  onKeyDown={onKey}
                  onCancel={cancel}
                  onSend={send}
                  personalReadOnly={isViewingAsOther}
                  onAttach={openFilePicker}
                  onRemoveAttachment={removeAttachment}
                  className="w-full"
                  variant="default"
                  chrome="pill"
                  heroRevealProgress={heroRevealProgress}
                  autoFocus
                />
              </div>
            </div>
          </div>
        </div>
      ) : (
      <div
        ref={scrollHostRef}
        {...{ [CHAT_SCROLL_HOST_ATTR]: "" }}
        onScroll={onTranscriptScrollWithRail}
        className={`relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden ${WIDGET_CHAT_COLUMN_CLASS}`}
        style={{ overflowAnchor: "none" }}
      >
        <div
          ref={transcriptInnerRef}
          className={`relative ${WIDGET_CHAT_COLUMN_CLASS}`}
          style={{ overflowAnchor: "none" }}
        >
          <VirtualList
            ref={virtualListRef}
            items={displayRuns}
            scrollRef={scrollHostRef}
            estimateSize={() => TERMCHAT_TURN_ESTIMATE_PX}
            getItemKey={(_i, run) => run.id}
            overscan={6}
            adjustScrollOnResize={false}
            renderItem={renderDisplayRun}
          />
          <div className={CHAT_TRANSCRIPT_BOTTOM_PAPER_CLASS} aria-hidden />
        </div>
      </div>
      )}
      </div>

      {showJumpButton && !showEmptyState && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
          <div className="pointer-events-auto">
            <ScrollToLatestButton onClick={jumpToLatest} />
          </div>
        </div>
      )}
      </div>
      </ChatScrollProvider>

      {!showEmptyState && (
        <div className={`termchat-input-dock termchat-input-dock--composer ${
          isHomeMode ? HOME_CHAT_INPUT_DOCK_CLASS : WIDGET_CHAT_INPUT_DOCK_CLASS
        }`}>
          <div className={`relative z-20 ${isHomeMode ? HOME_CHAT_COLUMN_CLASS : WIDGET_CHAT_COLUMN_CLASS}`}>
            {activeRunInterrupted ? (
              <ChatRunInterruptedBar
                message={activeRunInterrupted}
                canResume={canResumeInterrupted}
                onResume={() => { void resumeInterruptedRun() }}
                resuming={resumingRun}
              />
            ) : null}
            <TermChatInputBar
              input={input}
              isRunning={isRunning}
              slashOnlyMode={slashOnlyMode}
              slashCommands={slashCommands}
              commandConsole={cmdConsole}
              pendingInput={pendingInput}
              sending={sending}
              textareaRef={setTextareaRef}
              attachments={pendingAttachments}
              onChange={handleInputChange}
              onKeyDown={onKey}
              onCancel={cancel}
              onSend={send}
              personalReadOnly={isViewingAsOther}
              onAttach={openFilePicker}
              onRemoveAttachment={removeAttachment}
              className="w-full"
              variant={isHomeMode && showEmptyState ? "hero" : "default"}
              chrome="pill"
              heroRevealProgress={heroRevealProgress}
            />
          </div>
        </div>
      )}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      <ChatTableExportModal
        open={tableExportOpen}
        onClose={() => setTableExportOpen(false)}
        runs={scopedRuns}
        preferredRunId={scopedActiveRunId}
        onExported={(message) => cmdConsole.api.logSuccess(message)}
        onError={(message) => cmdConsole.api.logError(message)}
      />
    </div>
  )
}
