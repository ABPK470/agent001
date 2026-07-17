/**
 * Pass 2: turn each bucket into a fully populated OperationPipeline
 * (title, status, activities) by delegating to the pipeline-specific builders.
 */

import { OperationKind } from "../../../../internal/enums/operations.js"
import type { OperationPipeline } from "./types.js"
import { buildAgentRunPipeline } from "./pipelines/agent-run.js"
import { buildProposerRunPipeline } from "./pipelines/proposer-run.js"
import { buildBridgePipeline } from "./pipelines/bridge.js"
import { buildSyncPipeline } from "./pipelines/sync.js"
import { buildSystemPipeline } from "./pipelines/system.js"
import type { EventBucket } from "./types.js"

export function buildPipelinesFromBuckets(buckets: Iterable<EventBucket>): OperationPipeline[] {
  const operations: OperationPipeline[] = []

  for (const bucket of buckets) {
    if (bucket.kind === OperationKind.AgentRun) {
      operations.push(buildAgentRunPipeline(bucket.key.slice(4), bucket.events))
    } else if (bucket.kind === OperationKind.ProposerRun) {
      operations.push(buildProposerRunPipeline(bucket.key.slice(9), bucket.events))
    } else if (bucket.kind === OperationKind.SyncPreview || bucket.kind === OperationKind.SyncExecute) {
      const planId = bucket.planId ?? bucket.key.slice(5)
      operations.push(buildSyncPipeline(planId, bucket.kind, bucket.events))
    } else if (
      bucket.kind === OperationKind.BridgePreview ||
      bucket.kind === OperationKind.BridgeRun
    ) {
      // key = bridge:<moveId>:preview|run
      const parts = bucket.key.split(":")
      const moveId = parts[1] ?? bucket.key
      operations.push(buildBridgePipeline(moveId, bucket.kind, bucket.events))
    } else {
      operations.push(buildSystemPipeline(bucket.key, bucket.events))
    }
  }

  operations.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  return operations
}
