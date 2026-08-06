/**
 * Pure builders for Trace thread/run Listboxes — same order rules as Threads.
 */

import type { Run, Thread } from "../../types"
import type { ListboxOption } from "../../components/Listbox"
import { sortThreadsByPinThenUpdatedAt } from "../../lib/thread-order"
import { collapseResumeRunChains } from "../termchat/collapseResumeChains"

const COMBINED_SEP = "::"

function sortRunsNewestFirst(runs: readonly Run[]): Run[] {
  return [...runs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
}

/** One row per user goal — resume parents collapsed (same as Threads). */
export function displayRunsForThread(runs: readonly Run[]): Run[] {
  return sortRunsNewestFirst(collapseResumeRunChains(runs))
}

export function runsForActiveThread(
  runs: readonly Run[],
  threadId: string | null,
): Run[] {
  if (!threadId) return []
  return displayRunsForThread(runs.filter((run) => run.threadId === threadId))
}

export function threadLabel(thread: Thread): string {
  const title = thread.title?.trim()
  return title && title.length > 0 ? title : "New thread"
}

export function runLabel(run: Run): string {
  const goal = run.goal?.trim()
  if (goal && goal.length > 0) return goal
  return run.id.slice(0, 8)
}

export function threadOptions(threads: readonly Thread[]): ListboxOption<string>[] {
  return sortThreadsByPinThenUpdatedAt(threads).map((thread) => ({
    value: thread.id,
    label: threadLabel(thread),
  }))
}

export function runOptionsForThread(
  runs: readonly Run[],
  threadId: string | null,
): ListboxOption<string>[] {
  return runsForActiveThread(runs, threadId).map((run) => ({
    value: run.id,
    label: runLabel(run),
    hint: run.status,
  }))
}

/**
 * Listbox value must be ∈ options. Store already rewrites activeRunId on
 * selectThread; this keeps the trigger coherent if options are empty/mid-paint.
 */
export function resolveRunListboxValue(
  runsForThread: readonly { id: string }[],
  activeRunId: string | null,
): string {
  if (activeRunId && runsForThread.some((run) => run.id === activeRunId)) {
    return activeRunId
  }
  return runsForThread[0]?.id ?? ""
}

export function encodeCombinedValue(threadId: string, runId: string): string {
  return `${threadId}${COMBINED_SEP}${runId}`
}

export function decodeCombinedValue(
  value: string,
): { threadId: string; runId: string } | null {
  const i = value.indexOf(COMBINED_SEP)
  if (i <= 0) return null
  const threadId = value.slice(0, i)
  const runId = value.slice(i + COMBINED_SEP.length)
  // Empty runId = thread with no runs (combined picker → selectThread only).
  if (!threadId) return null
  return { threadId, runId }
}

/** Flat Thread › Run options for narrow (&lt;420px) combined picker. */
export function combinedRunOptions(
  threads: readonly Thread[],
  runs: readonly Run[],
): ListboxOption<string>[] {
  const out: ListboxOption<string>[] = []
  for (const thread of sortThreadsByPinThenUpdatedAt(threads)) {
    const threadRuns = runsForActiveThread(runs, thread.id)
    if (threadRuns.length === 0) {
      out.push({
        value: encodeCombinedValue(thread.id, ""),
        label: `${threadLabel(thread)} › No runs`,
      })
      continue
    }
    for (const run of threadRuns) {
      out.push({
        value: encodeCombinedValue(thread.id, run.id),
        label: `${threadLabel(thread)} › ${runLabel(run)}`,
        hint: run.status,
      })
    }
  }
  return out
}

export function resolveCombinedListboxValue(
  threads: readonly Thread[],
  runs: readonly Run[],
  activeThreadId: string | null,
  activeRunId: string | null,
): string {
  if (!activeThreadId) return ""
  const threadRuns = runsForActiveThread(runs, activeThreadId)
  const runId = resolveRunListboxValue(threadRuns, activeRunId)
  return encodeCombinedValue(activeThreadId, runId)
}

export const TRACE_RUN_CONTEXT_COMBINED_MAX_PX = 420
