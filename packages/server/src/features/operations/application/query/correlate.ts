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

    let kind: OperationKind
    let key: string
    let bucketPlanId: string | undefined

    if (planId && ev.type.startsWith("sync.execute")) {
      kind = OperationKind.SyncExecute
      key = `plan:${planId}:execute`
      bucketPlanId = planId
    } else if (planId && ev.type.startsWith("sync.preview")) {
      kind = OperationKind.SyncPreview
      key = `plan:${planId}:preview`
      bucketPlanId = planId
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
