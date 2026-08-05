/**
 * Collapse approval-resume run chains into one chat / threads row.
 *
 * Approve parks the parent and spawns a child with the same goal + parentRunId.
 * Without collapsing, TermChat shows duplicate goals and cancel noise per approval.
 * Pause markers are stripped on merge — the modal owns approval UX; tool rows show work.
 */

import type { Run, TraceEntry } from "@mia/shared-types"
import { stripApprovalWaitTraceEntries } from "../../lib/approval-trace"

/** True when this run was closed only because a resume child continued it. */
export function isSupersededByResume(run: Run, runs: readonly Run[]): boolean {
  return runs.some((r) => r.parentRunId === run.id)
}

/**
 * Resume chains drop approval pause markers — the modal + tool rows carry that story.
 * Keeping them produced N× "Approved … — continued" and stacked "Paused …" lines.
 */
export function dropApprovalWaitTraceEntries(entries: readonly TraceEntry[]): TraceEntry[] {
  return stripApprovalWaitTraceEntries(entries)
}

function chainRootToLeaf(leaf: Run, byId: Map<string, Run>): Run[] {
  const chain: Run[] = [leaf]
  let cur = leaf
  const guard = new Set<string>([leaf.id])
  while (cur.parentRunId) {
    const parent = byId.get(cur.parentRunId)
    if (!parent || guard.has(parent.id)) break
    guard.add(parent.id)
    chain.unshift(parent)
    cur = parent
  }
  return chain
}

function mergeResumeChain(chain: Run[]): Run {
  const root = chain[0]!
  const leaf = chain[chain.length - 1]!
  if (chain.length === 1) return leaf

  const trace: TraceEntry[] = []
  for (const run of chain) {
    trace.push(...dropApprovalWaitTraceEntries(run.trace ?? []))
  }

  return {
    ...leaf,
    goal: root.goal,
    createdAt: root.createdAt,
    parentRunId: null,
    trace,
    // Prefer leaf answer/streaming; sum step counts for a saner chip.
    stepCount: chain.reduce((n, r) => n + (r.stepCount || 0), 0),
  }
}

/**
 * One display run per approval-resume chain (root goal + merged traces + leaf status).
 * Chronological by root createdAt.
 */
export function collapseResumeRunChains(runs: readonly Run[]): Run[] {
  if (runs.length <= 1) return [...runs]

  const byId = new Map(runs.map((r) => [r.id, r]))
  const superseded = new Set<string>()
  for (const r of runs) {
    if (r.parentRunId && byId.has(r.parentRunId)) superseded.add(r.parentRunId)
  }

  const leaves = runs.filter((r) => !superseded.has(r.id))
  const collapsed = leaves.map((leaf) => mergeResumeChain(chainRootToLeaf(leaf, byId)))

  return collapsed.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )
}

/** Ids in the resume chain ending at `leafId` (root → leaf), for trace hydration. */
export function resumeChainIds(leafId: string, runs: readonly Run[]): string[] {
  const byId = new Map(runs.map((r) => [r.id, r]))
  const leaf = byId.get(leafId)
  if (!leaf) return [leafId]
  return chainRootToLeaf(leaf, byId).map((r) => r.id)
}
