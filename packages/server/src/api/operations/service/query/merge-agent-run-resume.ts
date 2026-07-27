/**
 * Collapse approval-resume agent-run pipelines into one row per user goal.
 *
 * Approve cancels the waiting parent and spawns a child (`parent_run_id`).
 * Chat already collapses that chain; Pipelines must too — otherwise 3
 * approvals → 3 cancelled + 1 completed for a single goal.
 */

import { OperationKind } from "../../../../internal/enums/operations.js"
import type { OperationPipeline } from "./types.js"
import { durationOf } from "./utils.js"

export type AgentRunResumeLookup = {
  parentRunId(runId: string): string | null
  hasResumeChild(runId: string): boolean
  /** Root goal + createdAt walking parent_run_id (DB). */
  rootMeta(runId: string): { startedAt: string; title: string } | null
}

function truncateTitle(goal: string): string {
  return goal.length > 100 ? `${goal.slice(0, 97)}…` : goal
}

function chainInPage(
  leaf: OperationPipeline,
  byId: Map<string, OperationPipeline>,
  parentOf: Map<string, string | null>,
): OperationPipeline[] {
  const chain: OperationPipeline[] = [leaf]
  const guard = new Set<string>([leaf.id])
  let cur = leaf
  while (true) {
    const pid = parentOf.get(cur.id)
    if (!pid || guard.has(pid)) break
    const parent = byId.get(pid)
    if (!parent) break
    guard.add(pid)
    chain.unshift(parent)
    cur = parent
  }
  return chain
}

function mergeChain(
  chain: OperationPipeline[],
  root: { startedAt: string; title: string },
): OperationPipeline {
  const leaf = chain[chain.length - 1]!
  if (chain.length === 1) {
    return {
      ...leaf,
      title: root.title,
      startedAt: root.startedAt,
      durationMs: durationOf(root.startedAt, leaf.endedAt),
    }
  }

  const activities = chain.flatMap((pipe) => pipe.activities)
  const eventCount = chain.reduce((n, pipe) => n + pipe.eventCount, 0)
  return {
    ...leaf,
    title: root.title,
    startedAt: root.startedAt,
    durationMs: durationOf(root.startedAt, leaf.endedAt),
    activities,
    activityCount: activities.length,
    eventCount,
  }
}

/**
 * One pipeline per approval-resume leaf. Superseded cancelled parents drop out.
 */
export function mergeAgentRunResumePipelines(
  operations: readonly OperationPipeline[],
  lookup: AgentRunResumeLookup,
): OperationPipeline[] {
  const agent = operations.filter((op) => op.kind === OperationKind.AgentRun)
  const rest = operations.filter((op) => op.kind !== OperationKind.AgentRun)
  if (agent.length === 0) return [...operations]

  const byId = new Map(agent.map((op) => [op.id, op]))
  const parentOf = new Map<string, string | null>()
  for (const op of agent) {
    parentOf.set(op.id, lookup.parentRunId(op.id))
  }

  const superseded = new Set<string>()
  for (const op of agent) {
    const parentId = parentOf.get(op.id)
    if (parentId && byId.has(parentId)) superseded.add(parentId)
    if (lookup.hasResumeChild(op.id)) superseded.add(op.id)
  }

  const leaves = agent.filter((op) => !superseded.has(op.id))
  const collapsed = leaves.map((leaf) => {
    const chain = chainInPage(leaf, byId, parentOf)
    const meta = lookup.rootMeta(leaf.id)
    const root = meta ?? {
      startedAt: chain[0]!.startedAt,
      title: chain[0]!.title,
    }
    return mergeChain(chain, {
      startedAt: root.startedAt,
      title: truncateTitle(root.title),
    })
  })

  return [...rest, ...collapsed].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}
