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
  compactToolPreview,
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
import {
  extractToolCode,
  formatToolInputDisplay,
} from "../components/tool-code-display"
import { ScrollToLatestButton } from "../components/ScrollToLatestButton"
import { SmartAnswer } from "../components/SmartAnswer"
import { STICKY_GOAL_HOME_TOP, StickyUserGoal } from "../components/StickyUserGoal"
import { TypewriterAnswer } from "../components/TypewriterAnswer"
import { RunStatus } from "../enums"
import { useMe } from "../hooks/useMe"
import { ToastStack, useWidgetToasts } from "../components/useWidgetToasts"
import { useStickToBottomScroll } from "../hooks/useStickToBottomScroll"
import { CHAT_SCROLL_HOST_ATTR, isNearBottom } from "../lib/chatScroll"
import { syncProgressResultLine } from "../state/sync-trace-progress"
import {
  HOME_CHAT_COLUMN_CLASS,
  HOME_CHAT_GUTTER_X_CLASS,
  HOME_CHAT_INPUT_DOCK_CLASS,
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
  canElementScrollVertically,
  deriveActiveMilestoneLabel,
  formatDeliverableBytes,
  isOffThreadProgress,
  summarizeHistory,
  summarizeRunError,
} from "./termchat/milestone"

// Local cap mirrors the Fastify route limit. Larger files get a friendly
// inline error instead of round-tripping for a 413.
const ATTACH_MAX_BYTES = 32 * 1024 * 1024
const USER_GOAL_COLLAPSE_LINES = 3

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
          className="inline-flex items-center gap-1 text-[15px] font-medium text-text-muted transition-colors hover:text-text"
        >
          <span>{expanded ? "Show less" : "Show more"}</span>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
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
  const shellClass =
    "overflow-hidden rounded-2xl border border-border-subtle bg-panel-2 text-[15px] leading-relaxed text-text dark:bg-bubble-user"
  const shellStyle = { boxShadow: "var(--shadow-bubble)" }
  const bodyClass = "min-w-0 px-5 py-3"
  const appendageClass =
    `flex shrink-0 items-center justify-center self-stretch ${userGoalPinSlotClass()} border-r border-border-subtle/70 bg-panel text-text-muted transition-colors hover:bg-panel-2 hover:text-text dark:border-white/8 dark:bg-black/10 dark:hover:bg-bubble-user dark:hover:text-text`

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
    <div className={`ml-auto flex w-full max-w-full items-stretch ${shellClass}`} style={shellStyle}>
      <button
        type="button"
        onClick={onUnpin}
        className={appendageClass}
        title="Unpin message"
        aria-label="Unpin message"
      >
        <Dot size={15} strokeWidth={2} />
      </button>
      <div className={`${bodyClass} min-w-0 flex-1`}>
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
}): React.ReactElement {
  const turnRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef<HTMLDivElement>(null)
  const [isStuck, setIsStuck] = useState(false)
  const { pauseAutoScroll, scrollHostRef } = useChatScroll()
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
    pauseAutoScroll()
    onUnpin(run.id)
  }

  const isOwnGoal = !run.upn || run.upn.toLowerCase() === me?.upn?.toLowerCase()

  return (
    <div
      ref={turnRef}
      data-run-id={run.id}
      className={`relative ${isHomeMode ? "mb-8" : "mb-10"}`}
    >
      <div ref={sentinelRef} data-run-goal-anchor className="h-px w-full shrink-0" aria-hidden />
      {/* flex + gap (not margin): home and widget share one rhythm; sticky
          cannot collapse this space. */}
      <div className={`flex min-w-0 flex-col ${USER_GOAL_TO_RESPONSE_GAP_CLASS}`}>
        <StickyUserGoal
          ref={stickyRef}
          align="end"
          topClass={pinProfile === "home" ? STICKY_GOAL_HOME_TOP : pinTopClass}
          className="shrink-0"
          pinned={pinned}
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

        <div className="min-w-0">
          <RunMessage
            run={run}
            isActive={isActive}
            pendingInput={pendingInput}
            onRespond={onRespond}
            onNotify={onNotify}
            onNotifyError={onNotifyError}
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

import { termToolDisplayLabel } from "@mia/shared-types"
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


function findNestedScrollable(target: EventTarget | null, container: HTMLDivElement): HTMLElement | null {
  let node = target instanceof HTMLElement ? target : null
  while (node && node !== container) {
    const style = window.getComputedStyle(node)
    const overflowY = style.overflowY
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight + 1) {
      return node
    }
    node = node.parentElement
  }
  return null
}

// Inline scrollable detail area for raw (non-extracted) tool payloads.
// Inherits the surrounding panel background (no dark slab) and applies
// a soft fade mask on top/bottom only when content actually overflows
// the height cap, so rows visually dissolve into the edge as the user
// scrolls instead of being hard-clipped.
function ScrollMaskedDetails({ text, maxHeight }: { text: string; maxHeight: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState<{ top: boolean; bottom: boolean }>({ top: false, bottom: false })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const overflow = el.scrollHeight > el.clientHeight + 1
      setEdges({
        top: overflow && el.scrollTop > 0,
        bottom: overflow && el.scrollTop + el.clientHeight < el.scrollHeight - 1,
      })
    }
    update()
    el.addEventListener("scroll", update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener("scroll", update)
      ro.disconnect()
    }
  }, [text])

  const maskStyle = useMemo<React.CSSProperties>(() => {
    // Top-only fade — same rationale as IterationToolList.
    if (!edges.top) return {}
    const mask = `linear-gradient(180deg, transparent 0px, black 22px, black 100%)`
    return { WebkitMaskImage: mask, maskImage: mask, WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat" }
  }, [edges.top])

  return (
    <div
      ref={ref}
      className="code-pre overflow-auto px-3 py-2.5"
      style={{ maxHeight, ...maskStyle }}
    >
      {text}
    </div>
  )
}

function ToolSyncProgressBody({ part }: { part: ResponseSyncProgressPart }) {
  const isRunning = part.status === "running"
  const tone = part.level === "error" || part.status === "error" ? "error" : "neutral"
  const lineClass = ["text-[15px] leading-5 font-mono", tone === "error" ? "text-error" : "text-text-faint"].join(" ")
  // Skip stub/trivial statuses ("ok", "done") — they read as orphan junk under the SQL chip.
  // Real SSE summaries look like "Preview complete — plan abc12345: +3 ~1 -0".
  const resultLine = syncProgressResultLine(part.result, part.status)

  // Same indent as expanded tool I/O — no second border-l (parent timeline owns the rail).
  return (
    <div className="ml-[14px] mt-1 pl-3 space-y-1">
      <p className={["text-[15px] leading-5 font-mono", isRunning ? "activity-shimmer-tight text-text-muted" : "text-text-secondary"].join(" ")}>
        {part.headline}
      </p>
      {part.detail && <p className={lineClass}>{part.detail}</p>}
      {part.sql?.preview && (
        <div className="rounded-md border border-border-subtle overflow-hidden">
          <div className={`px-2.5 py-1 border-b border-border-subtle ${lineClass}`}>
            {part.sql.label} · {part.sql.connection}
            {part.sql.rowCount != null ? ` · ${part.sql.rowCount} rows` : ""}
            {part.sql.durationMs != null ? ` · ${part.sql.durationMs}ms` : ""}
          </div>
          <CodeBlock code={part.sql.preview} lang="sql" maxHeight={120} />
        </div>
      )}
      {resultLine ? (
        <p className={["text-[15px] leading-5 font-mono", part.status === "error" ? "text-error" : "text-text-secondary"].join(" ")}>
          {resultLine}
        </p>
      ) : null}
    </div>
  )
}

function ToolPill({
  row,
  syncProgress,
  isLast,
  isLiveRun = false,
}: {
  row: ToolRow
  syncProgress?: ResponseSyncProgressPart
  isLast: boolean
  isLiveRun?: boolean
}) {
  const { preserveToggle } = useChatScroll()
  const label = termToolDisplayLabel(row.tool)
  const isRunning = row.status === "running" && isLiveRun
  const calmRunning = isRunning && row.tool === "ask_user"
  const [expanded, setExpanded] = useState(false)
  // Pill preview uses `summary` (short — argsSummary like `command="python3 -"`
  // or extracted target). The expanded body now renders TWO blocks: the
  // raw input (argsFormatted, e.g. the full `command` or `query`) and
  // the tool's output (details). Previously the expanded body showed
  // only the output — the input was hidden once the result arrived
  // because `details` was overloaded for both.
  const previewText = (() => {
    if (expanded) return ""
    if (syncProgress && !isRunning) {
      return syncProgress.detail?.trim() || syncProgress.headline?.trim() || compactToolPreview(row.summary || "")
    }
    return compactToolPreview(row.summary || "")
  })()
  const hasInput = Boolean(row.argsFormatted && row.argsFormatted.trim().length > 0)
  const hasOutput = Boolean(row.details && row.details.trim().length > 0)
  const canExpand = hasInput || hasOutput || Boolean(syncProgress)
  const extractedInput = row.argsFormatted ? extractToolCode(row.tool, row.argsFormatted) : null
  const displayInput = row.argsFormatted ? formatToolInputDisplay(row.tool, row.argsFormatted) : ""
  const extractedOutput = row.details ? extractToolCode(row.tool, row.details) : null
  const isError = row.status === "error"
  const buttonRef = useRef<HTMLButtonElement>(null)
  // Sync progress detail only while live or when the user expands the row —
  // never dump headline/SQL under a collapsed pill.
  const showSyncProgress = Boolean(syncProgress) && (expanded || isRunning)
  return (
    <div className="relative py-0.5">
      {!isLast && <div className="pointer-events-none absolute left-[11px] top-[20px] -bottom-1 w-px bg-border-subtle" />}
      <div className="flex items-start gap-2 min-w-0 px-2 py-1">
        <span className={["shrink-0 w-1.5 h-1.5 rounded-full mt-[7px]", isRunning ? calmRunning ? "bg-text-muted" : "bg-text-secondary animate-pulse" : row.status === "done" || row.status === "running" ? "bg-text-muted" : "bg-text-faint"].join(" ")} />
        {/* Cap the pill content (label + preview) at 80% of the
            iteration-column width before CSS ellipsis kicks in, so even
            short paths leave breathing room on the right and the
            timeline doesn't feel edge-to-edge. */}
        <div className="min-w-0 flex-1 max-w-[80%]">
          {canExpand ? (
            <button
              ref={buttonRef}
              type="button"
              onClick={() => preserveToggle(buttonRef.current, () => setExpanded((value) => !value))}
              className="inline-flex min-w-0 max-w-full items-center gap-2 text-left transition-colors outline-none focus-visible:outline-none group cursor-pointer"
              style={{ width: "fit-content", maxWidth: "100%" }}
            >
              <span className="text-[15px] font-mono text-text-muted group-hover:text-text transition-colors">{label}</span>
              {previewText && !expanded && (
                <span
                  className="text-[15px] text-text-faint group-hover:text-text transition-colors font-mono min-w-0 flex-1 whitespace-nowrap overflow-hidden text-ellipsis"
                >
                  {previewText}
                </span>
              )}
            </button>
          ) : (
            <div className="flex min-w-0 max-w-full items-center gap-2">
              <span className="text-[15px] font-mono text-text-muted transition-colors">{label}</span>
              {previewText && !expanded && (
                <span className="text-[15px] text-text-faint font-mono min-w-0 flex-1 whitespace-nowrap overflow-hidden text-ellipsis">
                  {previewText}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      {showSyncProgress && syncProgress ? <ToolSyncProgressBody part={syncProgress} /> : null}
      {expanded && (hasInput || hasOutput) && (
        <div className="ml-[14px] mt-1 pl-3 space-y-2">
          {hasInput && row.argsFormatted && (
            <div className="rounded-md border border-border-subtle overflow-hidden">
              {extractedInput ? (
                <CodeBlock code={extractedInput.code} lang={extractedInput.lang} maxHeight={176} />
              ) : (
                <ScrollMaskedDetails text={displayInput} maxHeight={176} />
              )}
            </div>
          )}
          {hasOutput && row.details && (
            <div className={`rounded-md border overflow-hidden ${isError ? "border-error/40 bg-error-soft/30" : "border-border-subtle bg-overlay-1"}`}>
              {extractedOutput ? (
                <CodeBlock code={extractedOutput.code} lang={extractedOutput.lang} maxHeight={176} />
              ) : (
                <ScrollMaskedDetails text={row.details} maxHeight={176} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// One agent-loop iteration's worth of tool calls, encapsulated under a
// single collapsible header. Default-collapsed once the iteration is
// done so the thread stays scannable; auto-expanded while the
// iteration is still running so the user sees live activity.
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
  const [open, setOpen] = useState(false)
  const userToggledRef = useRef(false)
  // Live or completed: keep the newest tool block open until a real
  // assistant prose/answer lands after it. Planner status used to fake
  // narratives that collapsed tools and looked like the answer.
  useEffect(() => {
    if (userToggledRef.current) return
    if (isLastIteration && !hasNarrativeAfter) {
      setOpen(true)
    } else if (hasNarrativeAfter) {
      setOpen(false)
    }
  }, [isLastIteration, hasNarrativeAfter, part.hasRunning])

  const buttonRef = useRef<HTMLButtonElement>(null)
  const errored = part.tools.some((p) => p.row.status === "error")
  // Visual hierarchy: the block header is *system chrome* describing
  // what the agent did — it should read as muted grey so the bright
  // assistant prose (`NarrativeUpdate` paragraphs and the final answer)
  // visually dominate. Mirrors GitHub Copilot Chat's grey "Searched for
  // X / Updated Y" rows alternating with white assistant text.
  const headerToneClass = errored ? "text-text-faint" : "text-text-faint"
  const Chevron = open ? ChevronDown : ChevronRight

  return (
    <div className="py-1.5">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => preserveToggle(buttonRef.current, () => {
          userToggledRef.current = true
          setOpen((v) => !v)
        })}
        className={`inline-flex max-w-full items-center gap-1.5 py-0.5 text-left text-[15px] leading-6 transition-colors hover:text-text-secondary ${headerToneClass}`}
      >
        <Chevron size={12} strokeWidth={1.5} className="text-text-faint shrink-0" />
        <span>{part.summary}</span>
      </button>
      {open && (
        <div className="mt-0.5 pl-4 border-l border-border-subtle ml-[5px]">
          <IterationToolList tools={part.tools} syncByInvocation={syncByInvocation} stickToBottom={part.hasRunning && isLiveRun} />
        </div>
      )}
    </div>
  )
}

/** Expandable plan outline — named steps, not a bare "3 steps" chip. */
function PlanBlock({ part }: { part: ResponsePlanPart }) {
  const { preserveToggle } = useChatScroll()
  const [open, setOpen] = useState(part.steps.length > 0 && part.steps.length <= 8)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const Chevron = open ? ChevronDown : ChevronRight
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
    <div className="py-1">
      <button
        ref={buttonRef}
        type="button"
        onClick={() =>
          preserveToggle(buttonRef.current, () => setOpen((v) => !v))
        }
        className="inline-flex max-w-full items-center gap-1.5 py-0.5 text-left text-[15px] leading-6 text-text-muted transition-colors hover:text-text-secondary"
      >
        <Chevron size={12} strokeWidth={1.5} className="text-text-faint shrink-0" />
        <span>Plan</span>
        <span className="text-text-faint">
          {part.stepCount} step{part.stepCount !== 1 ? "s" : ""}
          {modeHint ? ` · ${modeHint}` : ""}
        </span>
      </button>
      {open && part.steps.length > 0 && (
        <ol className="mt-1 ml-[0.35rem] pl-3 border-l border-border-subtle space-y-1 list-none">
          {part.steps.map((step, i) => (
            <li key={`${step.name}-${i}`} className="flex gap-2 text-[15px] leading-6 text-text-muted">
              <span className="tabular-nums text-text-faint shrink-0 w-4">{i + 1}.</span>
              <span className="min-w-0">
                <span>{humanizeStepName(step.name)}</span>
                {step.type && (
                  <span className="ml-1.5 text-text-faint">
                    {step.type === "subagent_task" ? "subagent" : step.type.replace(/_/g, " ")}
                  </span>
                )}
              </span>
            </li>
          ))}
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
  const userToggledRef = useRef(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (userToggledRef.current) return
    if (part.hasRunning || keepOpen) setOpen(true)
    else if (!keepOpen && part.status !== "running") setOpen(false)
  }, [part.hasRunning, part.status, keepOpen])

  const hasTools = part.tools.length > 0
  const Chevron = open ? ChevronDown : ChevronRight
  // Step gaps are process detail — same muted chrome as successful steps.
  const labelClass =
    part.status === "running" ? "text-text-muted" : "text-text-faint"

  return (
    <div className="py-1">
      <button
        ref={buttonRef}
        type="button"
        disabled={!hasTools}
        onClick={() => {
          if (!hasTools) return
          preserveToggle(buttonRef.current, () => {
            userToggledRef.current = true
            setOpen((v) => !v)
          })
        }}
        className={`inline-flex max-w-full items-baseline gap-1.5 py-0.5 text-left text-[15px] leading-6 ${labelClass} ${hasTools ? "transition-colors hover:text-text-secondary" : "cursor-default"}`}
      >
        {hasTools ? (
          <Chevron size={12} strokeWidth={1.5} className="text-text-faint shrink-0 translate-y-[2px]" />
        ) : null}
        <span>{part.title}</span>
        {part.detail ? (
          <span className="text-[15px] text-text-faint font-normal"> · {part.detail}</span>
        ) : null}
      </button>
      {open && hasTools && (
        <div className="mt-0.5 ml-[0.35rem] pl-3 border-l border-border-subtle">
          <IterationToolList
            tools={part.tools}
            syncByInvocation={syncByInvocation}
            stickToBottom={part.hasRunning && isLiveRun}
          />
        </div>
      )}
    </div>
  )
}

// Caps the expanded iteration body so a single tool-call burst can't
// monopolise the chat viewport. Once content overflows the cap, the
// list becomes scrollable and rows visually dissolve into the top/bottom
// edges via a CSS mask so they "disappear" gradually rather than being
// hard-clipped. Auto-sticks to the bottom while running so newly
// appended tool rows stay in view.
const ITERATION_BODY_MAX_HEIGHT = 300

function IterationToolList({
  tools,
  syncByInvocation,
  stickToBottom = false,
}: {
  tools: ResponseToolPart[]
  syncByInvocation: Map<string, ResponseSyncProgressPart>
  stickToBottom?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const stickBottomRef = useRef(stickToBottom)
  const [edges, setEdges] = useState<{ top: boolean; bottom: boolean }>({ top: false, bottom: false })

  useEffect(() => {
    if (stickToBottom) stickBottomRef.current = true
  }, [stickToBottom])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const overflow = el.scrollHeight > el.clientHeight + 1
      setEdges({
        top: overflow && el.scrollTop > 0,
        bottom: overflow && el.scrollTop + el.clientHeight < el.scrollHeight - 1,
      })
    }
    const onScroll = () => {
      stickBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 24
      update()
    }
    if (stickBottomRef.current) el.scrollTop = el.scrollHeight
    update()
    el.addEventListener("scroll", onScroll, { passive: true })
    let resizeRaf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(resizeRaf)
      resizeRaf = requestAnimationFrame(() => {
        if (stickBottomRef.current) el.scrollTop = el.scrollHeight
        update()
      })
    })
    ro.observe(el)
    return () => {
      cancelAnimationFrame(resizeRaf)
      el.removeEventListener("scroll", onScroll)
      ro.disconnect()
    }
  }, [tools.length])

  const maskStyle = useMemo<React.CSSProperties>(() => {
    // Top-only fade — rows visually dissolve into the upper edge as you
    // scroll past them. No bottom fade: the bottom of the list is the
    // "current" content (we auto-stick there) and a fade there would
    // suggest hidden content even when there isn't any.
    if (!edges.top) return {}
    const mask = `linear-gradient(180deg, transparent 0px, black 28px, black 100%)`
    return { WebkitMaskImage: mask, maskImage: mask, WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat" }
  }, [edges.top])

  return (
    <div
      ref={ref}
      className="overflow-y-auto"
      style={{ maxHeight: ITERATION_BODY_MAX_HEIGHT, ...maskStyle }}
    >
      {tools.map((toolPart, i) => (
        <ToolPill
          key={toolPart.id}
          row={toolPart.row}
          syncProgress={syncByInvocation.get(toolPart.id)}
          isLast={i === tools.length - 1}
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

function NarrativeUpdate({ part }: { part: ResponseNarrativePart }) {
  // Status lines = muted system chrome (same band as tool headers).
  // Prose = assistant voice — bright, dominates the thread.
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
    <div className={`py-1.5 pr-2 ${part.tone === "error" ? "text-text-muted" : "text-text"}`}>
      <SmartAnswer text={part.text} compact />
    </div>
  )
}

function ErrorNote({ text }: { text: string }) {
  // Same chrome as activity rows — never scream red mono for recoverable notes.
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

function DetailViewport({
  children,
  maxHeight = 300,
}: {
  children: React.ReactNode
  maxHeight?: number
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const shouldStickToBottomRef = useRef(true)
  const [overflowState, setOverflowState] = useState({ hasOverflow: false, top: false, bottom: false })

  const viewportMaskStyle = useMemo<React.CSSProperties>(() => {
    // Fade rows in/out as they cross the viewport edges so they feel like
    // they gradually disappear instead of being hard-clipped. Only apply
    // the fade on edges that actually have hidden content beyond them.
    const topFade = overflowState.top ? 28 : 0
    const bottomFade = overflowState.bottom ? 28 : 0

    if (topFade === 0 && bottomFade === 0) {
      return {}
    }

    const maskImage = `linear-gradient(180deg, transparent 0px, black ${topFade}px, black calc(100% - ${bottomFade}px), transparent 100%)`

    return {
      WebkitMaskImage: maskImage,
      maskImage,
      WebkitMaskRepeat: "no-repeat",
      maskRepeat: "no-repeat",
    }
  }, [overflowState.top, overflowState.bottom])

  useLayoutEffect(() => {
    const host = hostRef.current
    const inner = innerRef.current
    if (!host || !inner) return

    const updateOverflow = () => {
      const hasOverflow = host.scrollHeight > host.clientHeight + 1
      setOverflowState({
        hasOverflow,
        top: hasOverflow && host.scrollTop > 0,
        bottom: hasOverflow && host.scrollTop + host.clientHeight < host.scrollHeight - 1,
      })
    }

    const scrollToBottom = () => {
      host.scrollTop = host.scrollHeight
      updateOverflow()
    }

    const onScroll = () => {
      shouldStickToBottomRef.current = host.scrollTop + host.clientHeight >= host.scrollHeight - 24
      updateOverflow()
    }

    if (shouldStickToBottomRef.current) {
      scrollToBottom()
    } else {
      updateOverflow()
    }

    const resizeObserver = new ResizeObserver(() => {
      if (shouldStickToBottomRef.current) {
        scrollToBottom()
        return
      }
      updateOverflow()
    })
    resizeObserver.observe(inner)
    host.addEventListener("scroll", onScroll, { passive: true })

    return () => {
      resizeObserver.disconnect()
      host.removeEventListener("scroll", onScroll)
    }
  }, [children])

  return (
    <div className="mt-1 rounded-xl overflow-hidden">
      <div ref={hostRef} className="relative overflow-y-auto" style={{ maxHeight, ...viewportMaskStyle }}>
        <div ref={innerRef} className="relative z-0 px-2 pt-3 pb-4">
          {children}
        </div>
      </div>
    </div>
  )
}

function DetailViewportRows({
  parts,
  maxHeight,
}: {
  parts: Array<ResponseProgressPart | ResponseToolPart>
  maxHeight?: number
}) {
  return (
    <DetailViewport maxHeight={maxHeight}>
      <div className="space-y-0.5">
        {parts.map((part, index) => (
          part.kind === "progress"
            ? <ProgressPill key={`${part.id}-${index}`} part={part} />
            : <ToolPill key={`${part.id}-${index}`} row={part.row} isLast={index === parts.length - 1} />
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
    <div className="pt-1 pb-4">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => preserveToggle(buttonRef.current, () => setOpen((value) => !value))}
        className="inline-flex max-w-full items-center gap-1.5 py-1 text-left text-[15px] text-text-faint hover:text-text-secondary transition-colors"
      >
        {open ? <ChevronDown size={12} strokeWidth={1.5} className="text-text-faint shrink-0" /> : <ChevronRight size={12} strokeWidth={1.5} className="text-text-faint shrink-0" />}
        <span className="truncate">{summary}</span>
      </button>

      {open && (
        <div className="pt-0.5 pl-1">
          <DetailViewportRows parts={parts} maxHeight={280} />
        </div>
      )}
    </div>
  )
}
void HistoryDisclosure

// ── Run error ─────────────────────────────────────────────────────

function RunErrorBanner({ error }: { error: string }) {
  const [expanded, setExpanded] = useState(false)
  const { summary, details } = summarizeRunError(error)
  const showDetails = details != null && details !== summary

  return (
    <div className="max-w-full rounded-lg border border-error/30 bg-error/5 px-3 py-2.5">
      <div className="text-[15px] font-medium leading-6 text-error">Run failed</div>
      <p className="mt-1 text-[15px] leading-5 text-error/85 break-words">{summary}</p>
      {showDetails && (
        <>
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="mt-2 text-[15px] font-medium text-error/75 hover:text-error"
          >
            {expanded ? "Hide details" : "Show details"}
          </button>
          {expanded && (
            <pre className="code-pre mt-2 max-h-40 overflow-auto rounded-md border border-error/20 bg-error/5 px-2.5 py-2 text-error/80">
              {details}
            </pre>
          )}
        </>
      )}
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
      const result = await api.downloadRunWorkspaceFiles(runId, downloadablePaths)
      onNotify?.(
        result.count === 1
          ? "Saved to your computer"
          : `Saved ${result.count} files to your computer`,
      )
      setDownloaded(true)
    } catch (err) {
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
        {open ? <ChevronDown size={12} strokeWidth={1.5} className="text-text-faint" /> : <ChevronRight size={12} strokeWidth={1.5} className="text-text-faint" />}
      </button>

      {open && diff && (
        <div className="px-3 pb-2 space-y-0.5 border-t border-border-subtle">
          {diff.added.map((f) => (
            <div key={f} className="flex items-center gap-1.5 text-[15px] font-mono">
              <span className="text-success shrink-0">+</span>
              <span className="text-text-muted truncate">{f}</span>
            </div>
          ))}
          {diff.modified.map((f) => (
            <div key={f} className="flex items-center gap-1.5 text-[15px] font-mono">
              <span className="text-warning shrink-0">~</span>
              <span className="text-text-muted truncate">{f}</span>
            </div>
          ))}
          {diff.deleted.map((f) => (
            <div key={f} className="flex items-center gap-1.5 text-[15px] font-mono">
              <span className="text-error shrink-0">−</span>
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
          title="Download to your computer — you choose where to save"
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
}: {
  run: {
    id: string
    status: string
    answer: string | null
    error: string | null
    pendingWorkspaceChanges?: number
    trace?: TraceEntry[]
    streamingAnswer?: string
  }
  isActive: boolean
  pendingInput?: { runId: string; question: string; options?: string[]; sensitive?: boolean } | null
  onRespond: (runId: string, response: string) => Promise<void> | void
  onNotify?: (message: string) => void
  onNotifyError?: (message: string) => void
}) {
  const trace = run.trace ?? []
  const liveStreamingAnswer = isActive && isRunActiveStatus(run.status) ? (run.streamingAnswer ?? "") : ""
  const responseParts = useMemo(
    () => buildResponseParts(trace, run.status, liveStreamingAnswer, run.answer, run.error, pendingInput ?? null, run.id),
    [trace, run.status, liveStreamingAnswer, run.answer, run.error, pendingInput, run.id],
  )
  const isDone = !isRunActiveStatus(run.status)
  const isLiveRun = isActive && !isDone

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

    responseParts.forEach((part) => {
      if (part.kind === "plan") {
        items.push(<PlanBlock key={part.id} part={part} />)
        return
      }

      if (part.kind === "step-block") {
        const meta = iterationMeta.get(part.id)
        items.push(
          <StepBlock
            key={part.id}
            part={part}
            syncByInvocation={syncByInvocation}
            isLiveRun={isLiveRun}
            keepOpen={Boolean(meta?.isLastWork && !meta.hasNarrativeAfter)}
          />,
        )
        if (part.hasRunning) lastToolHasRunning = true
        else lastToolHasRunning = false
        return
      }

      if (part.kind === "progress") {
        if (isOffThreadProgress(part)) return
        items.push(<ProgressPill key={part.id} part={part} />)
        return
      }

      if (part.kind === "tool") {
        items.push(
          <ToolPill
            key={part.id}
            row={part.row}
            syncProgress={syncByInvocation.get(part.id)}
            isLast={false}
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

      {/* Terminal status — same rhythm as answer blocks under the user pill */}
      {run.status === "cancelled" && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5 text-[15px] leading-6 text-warning">
          Run cancelled.
        </div>
      )}
      {run.error && run.status !== "cancelled" && (
        <RunErrorBanner error={run.error} />
      )}

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
  heroRevealProgress = 1,
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
  heroRevealProgress?: number
}) {
  const slashInput = input.trimStart().startsWith("/")
  const attachDisabled = slashOnlyMode || !!pendingInput
  const goalPlaceholder = pendingInput
    ? "Respond in the prompt above ↑"
    : slashOnlyMode
      ? "Type /cancel, /trace, /status…"
      : "Enter your goal or press / for commands"
  const canSend = slashOnlyMode
    ? slashInput && input.trim().length > 1 && !sending
    : (Boolean(input.trim()) || attachments.length > 0) && !sending
  const showStop = isRunning && !slashInput && !pendingInput
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
          data-intro-target="termchat-input"
          className={`chathome-chrome-pill ${palette || hasResult ? "chathome-chrome-pill--composer-open" : "overflow-hidden"} ${className} mx-auto bg-elevated dark:bg-overlay-2 border border-border ring-1 ring-overlay-1 focus-within:border-border-strong focus-within:ring-overlay-2 transition-colors ${isHero ? "rounded-[24px] px-5 py-4" : "rounded-2xl px-4 py-3"}`}
          style={heroStyle}
      >
          <ChatComposerShell
            console={commandConsole}
            slashPalette={palette}
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
                      autoFocus
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
                              className="shrink-0 flex items-center justify-center w-10 h-10 rounded-xl bg-overlay-2 hover:bg-error/12 text-error transition-colors cursor-pointer"
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
                      autoFocus
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
                          className="shrink-0 flex items-center justify-center w-9 h-9 rounded-lg bg-error-soft hover:bg-error/25 text-error transition-colors cursor-pointer"
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

  const runs = useStore((s) => s.runs)
  const activeRunId = useStore((s) => s.activeRunId)
  const setActiveRun = useStore((s) => s.setActiveRun)
  const upsertRun = useStore((s) => s.upsertRun)
  const pendingInput = useStore((s) => s.pendingInput)
  const clearPendingInput = useStore((s) => s.clearPendingInput)

  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const runRailScrollSyncRef = useRef<(() => void) | null>(null)
  const [scrollToRunId, setScrollToRunId] = useState<string | null>(null)
  const [transcriptFadeTop, setTranscriptFadeTop] = useState(false)
  const [transcriptFadeBottom, setTranscriptFadeBottom] = useState(false)
  const [unpinnedGoalRunIds, setUnpinnedGoalRunIds] = useState<Set<string>>(() => new Set())
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

  const scopedRuns = useMemo(
    () => runs.filter((r) => r.threadId === continuityThreadId),
    [runs, continuityThreadId],
  )

  const [tableExportOpen, setTableExportOpen] = useState(false)

  const { tryDispatchSlash, slashCommands, slashOnlyMode } = useChatSlashActions({
    activeThreadId: continuityThreadId,
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
    showJumpButton,
    stickIfFollowing,
  } = useStickToBottomScroll({
    resetKey: scrollToRunId,
    initialScroll: "none",
    followWhen: isRunning || Boolean(scopedActiveRun?.streamingAnswer),
    onScrollPosition: (scrollTop, host) => {
      if (!isHomeMode) return
      const overflows = host.scrollHeight > host.clientHeight + 1
      setTranscriptFadeTop(overflows && scrollTop > 24)
      setTranscriptFadeBottom(overflows && !isNearBottom(host, 120))
    },
  })

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
      requestAnimationFrame(() => scrollToBottom("instant", { stick: true }))
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
  }, [input, sending, slashOnlyMode, setActiveRun, pendingAttachments, scrollToBottom, continuityThreadId, mode, tryDispatchSlash, clearDraft, setDraft, notifyError])

  const cancel = useCallback(async () => {
    if (!scopedActiveRunId) return
    try { await api.cancelRun(scopedActiveRunId) } catch (err: unknown) { console.error("[mia]", err) }
  }, [scopedActiveRunId])

  const uploadFiles = useCallback(async (files: File[]) => {
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

  useEffect(() => {
    const host = scrollHostRef.current
    if (!host) return

    const handleWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) < Math.abs(event.deltaX) || event.deltaY === 0) return

      const nestedScrollable = findNestedScrollable(event.target, host)
      if (!nestedScrollable || nestedScrollable === host) return
      if (canElementScrollVertically(nestedScrollable, event.deltaY)) return

      event.preventDefault()
      host.scrollTop += event.deltaY
    }

    host.addEventListener("wheel", handleWheel, { capture: true, passive: false })
    return () => host.removeEventListener("wheel", handleWheel, { capture: true })
  }, [])

  // Build message list: each "run" is a (user msg, assistant response) pair.
  // Always oldest → newest so the input bar sits under the most recent turn.
  const threadRunsChronological = useMemo(() => {
    const scoped = continuityThreadId
      ? runs.filter((r) => r.threadId === continuityThreadId)
      : runs
    return [...scoped].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    )
  }, [runs, continuityThreadId])

  // Transcript is always oldest → newest. Selecting a run (Threads widget)
  // must not yank that run to the bottom — that reorders the chat.
  const displayRuns = threadRunsChronological

  const showEmptyState = FORCE_EMPTY_STATE_PREVIEW || displayRuns.length === 0
  const latestDisplayRunId = displayRuns.length > 0 ? displayRuns[displayRuns.length - 1]!.id : null

  useLayoutEffect(() => {
    const host = scrollHostRef.current
    if (!host || !isHomeMode || showEmptyState) {
      setTranscriptFadeTop(false)
      setTranscriptFadeBottom(false)
      return
    }
    const overflows = host.scrollHeight > host.clientHeight + 1
    setTranscriptFadeTop(overflows && host.scrollTop > 24)
    setTranscriptFadeBottom(overflows && !isNearBottom(host, 120))
  }, [
    isHomeMode,
    showEmptyState,
    displayRuns,
    scopedActiveRun?.streamingAnswer,
    scopedActiveRun?.answer,
    scrollHostRef,
  ])

  const didSelectLatestRef = useRef(false)
  const didInitialAnchorRef = useRef(false)
  const hadActiveTraceRef = useRef(false)
  const traceHydratingRef = useRef(new Set<string>())

  const hydrateRunTrace = useCallback(async (runId: string) => {
    if (runId === scopedActiveRunId) return
    const run = runs.find((r) => r.id === runId)
    if (!run || isRunActiveStatus(run.status)) return
    if ((run.trace?.length ?? 0) > 0) return
    if (traceHydratingRef.current.has(runId)) return

    traceHydratingRef.current.add(runId)
    try {
      const rawTrace = await api.getRunTrace(runId)
      upsertRun({
        id: runId,
        trace: rawTrace as TraceEntry[],
        streamingAnswer: "",
      })
    } finally {
      traceHydratingRef.current.delete(runId)
    }
  }, [scopedActiveRunId, runs, upsertRun])

  // Hydrate completed run traces when their turn scrolls into view (not all at once).
  useEffect(() => {
    const host = scrollHostRef.current
    if (!host || displayRuns.length === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const runId = (entry.target as HTMLElement).dataset.runId
          if (!runId || runId === scopedActiveRunId) continue
          const run = runs.find((r) => r.id === runId)
          if (!run || isRunActiveStatus(run.status)) continue
          if ((run.trace?.length ?? 0) > 0) continue
          void hydrateRunTrace(runId).catch((err: unknown) => { console.error("[mia]", err) })
        }
      },
      { root: host, rootMargin: "240px 0px", threshold: 0 },
    )

    const turns = host.querySelectorAll<HTMLElement>("[data-run-id]")
    for (const turn of turns) observer.observe(turn)
    return () => observer.disconnect()
  }, [displayRuns, scopedActiveRunId, runs, hydrateRunTrace, scrollHostRef])

  useEffect(() => {
    didSelectLatestRef.current = false
    didInitialAnchorRef.current = false
    hadActiveTraceRef.current = false
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

  // Follow live output when the trace grows. Answer-token height is already
  // handled by useStickToBottomScroll's ResizeObserver — sticking again on
  // every streamingAnswer chunk double-scrolled and read as shake.
  useEffect(() => {
    if (!isRunning) return
    stickIfFollowing()
  }, [scopedActiveRun?.trace?.length, isRunning, stickIfFollowing])

  const jumpToLatest = useCallback(() => {
    resumeAutoFollow()
    if (latestDisplayRunId) setActiveRun(latestDisplayRunId)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollToBottom("instant", { stick: isRunning || Boolean(streamingAnswer) })
      })
    })
  }, [latestDisplayRunId, setActiveRun, scrollToBottom, isRunning, streamingAnswer, resumeAutoFollow])

  const jumpToRun = useCallback((runId: string) => {
    suspendAutoFollow()
    void hydrateRunTrace(runId).catch((err: unknown) => { console.error("[mia]", err) })
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const host = scrollHostRef.current
        const el =
          host?.querySelector<HTMLElement>(`[data-run-id="${runId}"] [data-run-goal-anchor]`)
          ?? host?.querySelector<HTMLElement>(`[data-run-id="${runId}"]`)
        el?.scrollIntoView({ behavior: "auto", block: "start" })
      })
    })
  }, [suspendAutoFollow, scrollHostRef, hydrateRunTrace])

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
      <ChatScrollProvider pauseAutoScroll={pauseAutoScroll} scrollHostRef={scrollHostRef}>
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
              : "flex min-h-0 flex-1 flex-col px-3 py-3 sm:px-5 sm:py-4"
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
            className={`${homeTranscriptScrollClassName()}${
              showEmptyState ? "" : " pb-6"
            }`}
            style={{ overflowAnchor: "none" }}
          >
            <div
              ref={transcriptInnerRef}
              className={
                showEmptyState
                  ? "min-h-full flex flex-col justify-center pb-[10vh]"
                  : "relative space-y-6"
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
                        onAttach={openFilePicker}
                        onRemoveAttachment={removeAttachment}
                        className={isHomeMode ? "w-full" : "w-full max-w-[860px]"}
                        variant={isHomeMode ? "hero" : "default"}
                        heroRevealProgress={heroRevealProgress}
                      />
                    </div>
                  </div>
                </div>
              )}

              {!showEmptyState && displayRuns.map((run) => (
                <ChatTurn
                  key={run.id}
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
                />
              ))}
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
                  onAttach={openFilePicker}
                  onRemoveAttachment={removeAttachment}
                  className="w-full"
                  variant="default"
                  heroRevealProgress={heroRevealProgress}
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
        className={`relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden ${WIDGET_CHAT_COLUMN_CLASS} space-y-8 sm:space-y-10`}
        style={{ overflowAnchor: "none" }}
      >
        <div
          ref={transcriptInnerRef}
          className={`relative ${WIDGET_CHAT_COLUMN_CLASS}`}
          style={{ overflowAnchor: "none" }}
        >
          {displayRuns.map((run) => (
            <ChatTurn
              key={run.id}
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
            />
          ))}
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
          isHomeMode ? HOME_CHAT_INPUT_DOCK_CLASS : "px-3 pb-3 pt-1 sm:px-5 sm:pb-4"
        }`}>
          <div className={`relative z-20 ${isHomeMode ? HOME_CHAT_COLUMN_CLASS : WIDGET_CHAT_COLUMN_CLASS}`}>
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
              onAttach={openFilePicker}
              onRemoveAttachment={removeAttachment}
              className="w-full"
              variant={isHomeMode && showEmptyState ? "hero" : "default"}
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
