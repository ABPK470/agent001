/**
 * Pass 1: assign each event to a bucket (agent run, sync preview/execute, or system).
 * Standalone sync events get their own pipeline even when they also carry a runId.
 */

import { OperationKind } from "../../../../shared/enums/operations.js"
import type { EventBucket, OperationEvent } from "./types.js"
import { resolveSyncPlanId, strField } from "./utils.js"

export function buildPreviewToPlanMap(events: readonly OperationEvent[]): Map<string, string> {
  const previewToPlan = new Map<string, string>()
  for (const ev of events) {
    const planId = strField(ev.data, "planId")
    const previewId = strField(ev.data, "previewId")
    if (planId && previewId) previewToPlan.set(previewId, planId)
  }
  return previewToPlan
}

export function correlateEventsIntoBuckets(
  events: readonly OperationEvent[],
  previewToPlan: Map<string, string>
): Map<string, EventBucket> {
  const buckets = new Map<string, EventBucket>()

  for (const ev of events) {
    const runId = strField(ev.data, "runId")
    const planId = resolveSyncPlanId(ev, previewToPlan)
    const isProposerEvent =
      ev.type.startsWith("sync.proposer") || ev.type.startsWith("sync.proposal")

    let kind: OperationKind
    let key: string
    let bucketPlanId: string | undefined

    if (isProposerEvent && runId) {
      kind = OperationKind.ProposerRun
      key = `proposer:${runId}`
    } else if (
      planId &&
      ev.type.startsWith("sync.") &&
      ev.type.endsWith(".sql")
    ) {
      const scope = strField(ev.data, "scope")
      const executeSql =
        ev.type === "sync.execute.sql" ||
        scope === "execute" ||
        scope === "rollback" ||
        scope === "metadata" ||
        scope === "apply"
      kind = executeSql ? OperationKind.SyncExecute : OperationKind.SyncPreview
      key = executeSql ? `plan:${planId}:execute` : `plan:${planId}:preview`
      bucketPlanId = planId
    } else if (planId && ev.type.startsWith("sync.execute")) {
      kind = OperationKind.SyncExecute
      key = `plan:${planId}:execute`
      bucketPlanId = planId
    } else if (planId && ev.type.startsWith("sync.preview")) {
      kind = OperationKind.SyncPreview
      key = `plan:${planId}:preview`
      bucketPlanId = planId
    } else if (ev.type.startsWith("bridge.")) {
      const moveId = strField(ev.data, "moveId") ?? `anon:${ev.timestamp}`
      const isRun = ev.type.startsWith("bridge.run")
      kind = isRun ? OperationKind.BridgeRun : OperationKind.BridgePreview
      key = isRun ? `bridge:${moveId}:run` : `bridge:${moveId}:preview`
    } else if (runId) {
      kind = OperationKind.AgentRun
      key = `run:${runId}`
    } else {
      kind = OperationKind.System
      key = `system:${ev.timestamp.slice(0, 16)}`
    }

    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { kind, key, events: [], ...(bucketPlanId ? { planId: bucketPlanId } : {}) }
      buckets.set(key, bucket)
    }
    bucket.events.push(ev)
  }

  return buckets
}
