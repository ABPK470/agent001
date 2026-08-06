/**
 * Pure nav helpers for Trace scope drawer — flat list of thread + run rows.
 */

export type ScopeDrawerItem =
  | { kind: "thread"; threadId: string; expanded: boolean }
  | { kind: "run"; threadId: string; runId: string }

export function buildScopeDrawerItems(
  threads: readonly { id: string }[],
  runsByThread: ReadonlyMap<string, readonly { id: string }[]>,
  expandedThreadIds: ReadonlySet<string>,
): ScopeDrawerItem[] {
  const out: ScopeDrawerItem[] = []
  for (const thread of threads) {
    const expanded = expandedThreadIds.has(thread.id)
    out.push({ kind: "thread", threadId: thread.id, expanded })
    if (!expanded) continue
    const runs = runsByThread.get(thread.id) ?? []
    for (const run of runs) {
      out.push({ kind: "run", threadId: thread.id, runId: run.id })
    }
  }
  return out
}

/** Prefer active run; else active thread; else first item. */
export function initialScopeDrawerIndex(
  items: readonly ScopeDrawerItem[],
  activeRunId: string | null,
  activeThreadId: string | null,
): number {
  if (activeRunId) {
    const runIdx = items.findIndex(
      (item) => item.kind === "run" && item.runId === activeRunId,
    )
    if (runIdx >= 0) return runIdx
  }
  if (activeThreadId) {
    const threadIdx = items.findIndex(
      (item) => item.kind === "thread" && item.threadId === activeThreadId,
    )
    if (threadIdx >= 0) return threadIdx
  }
  return items.length > 0 ? 0 : -1
}

export function moveScopeDrawerIndex(
  itemsLength: number,
  index: number,
  delta: number,
): number {
  if (itemsLength <= 0) return -1
  if (index < 0) return delta > 0 ? 0 : itemsLength - 1
  return Math.max(0, Math.min(itemsLength - 1, index + delta))
}
