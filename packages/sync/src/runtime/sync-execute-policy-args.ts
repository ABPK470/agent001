/**
 * Policy args for sync_execute.
 *
 * The tool schema is planId + confirm only — the write destination lives on
 * the plan. Before policy evaluation (HTTP or agent), attach plan facts onto
 * the args so selectors see `target` the same way on every path.
 */

import type { SyncPlan } from "../domain/plan.js"

export type SyncExecutePolicyPlan = Pick<SyncPlan, "source" | "target" | "entity">

/**
 * Merge durable plan facts into sync_execute args for policy / audit.
 * Caller args win when already set. Missing plan → args unchanged (fail closed).
 */
export function withSyncExecutePolicyArgs(
  args: Record<string, unknown>,
  plan: SyncExecutePolicyPlan | null | undefined,
): Record<string, unknown> {
  if (!plan) return args
  return {
    ...args,
    source: args["source"] ?? plan.source,
    target: args["target"] ?? plan.target,
    entityType: args["entityType"] ?? plan.entity.type,
    entityId: args["entityId"] ?? plan.entity.id,
  }
}
