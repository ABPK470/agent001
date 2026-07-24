/**
 * Collapse approval-resume run chains into one chat turn.
 *
 * Approve parks the parent and spawns a child with the same goal + parentRunId.
 * Without collapsing, TermChat shows: goal → "Waiting for approval" →
 * "Run cancelled." → fake new user bubble (often "yes") — once per approval.
 */

import type { Run, TraceEntry } from "@mia/shared-types"

const WAITING_APPROVAL_RE = /^Waiting for approval\s*[—–-]\s*([^:]+):\s*(.*)$/i

/** True when this run was closed only because a resume child continued it. */
export function isSupersededByResume(run: Run, runs: readonly Run[]): boolean {
  return runs.some((r) => r.parentRunId === run.id)
}

/**
 * Soften parked-approval error notes on parents that were later resumed.
 * Keep deny/cancel errors intact on true stops.
 */
export function softenApprovalTraceEntries(
  entries: readonly TraceEntry[],
  opts: { resumed: boolean },
): TraceEntry[] {
  if (!opts.resumed) return [...entries]
  return entries.map((entry) => {
    if (entry.kind !== "error") return entry
    const m = WAITING_APPROVAL_RE.exec(entry.text.trim())
    if (!m) return entry
    const tool = m[1]?.trim() || "tool"
    // Keep kind "error" (wire TraceEntry has no quiet status kind) — text is
    // the signal; TermChat ErrorNote is already muted system chrome.
    return {
      kind: "error",
      text: `Approved ${tool} — continued`,
    }
  })
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
  for (let i = 0; i < chain.length; i++) {
    const run = chain[i]!
    const resumed = i < chain.length - 1
    const piece = softenApprovalTraceEntries(run.trace ?? [], { resumed })
    trace.push(...piece)
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
