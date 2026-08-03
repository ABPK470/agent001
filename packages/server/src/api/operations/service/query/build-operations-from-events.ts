/**
 * Shared pass: chronological OperationEvent[] → correlated pipelines.
 */

import { isEventType } from "@mia/agent"
import type { DbEvent } from "../../../../infra/persistence/adapters/sqlite/db/events.js"
import { buildPipelinesFromBuckets } from "./build-pipelines.js"
import { buildPreviewToPlanMap, correlateEventsIntoBuckets } from "./correlate.js"
import { filterOperations } from "./filter.js"
import { mergeAgentRunResumePipelines } from "./merge-agent-run-resume.js"
import { mergeSyncPlanPipelines } from "./merge-sync-run.js"
import type { ListOperationsOpts, OperationEvent, OperationPipeline } from "./types.js"
import { hydratePersistedSqlEventData } from "../../../../infra/persistence/adapters/sqlite/db/sync-sql-log.js"
import * as db from "../../../../infra/persistence/sqlite.js"
import { safeParse } from "./utils.js"

async function mapDbEventRow(e: DbEvent): Promise<OperationEvent | null> {
  if (!isEventType(e.type)) return null
  const data = await hydratePersistedSqlEventData(e.type, safeParse(e.data))
  return { type: e.type, timestamp: e.created_at, data }
}

export async function mapDbEventsChronological(events: readonly DbEvent[]): Promise<OperationEvent[]> {
  const mapped = await Promise.all([...events].reverse().map(mapDbEventRow))
  return mapped.filter((event): event is OperationEvent => event !== null)
}

/** Map event_log rows already in ascending created_at order (plan/run audit queries). */
export async function mapDbEventsAsc(events: readonly DbEvent[]): Promise<OperationEvent[]> {
  const mapped = await Promise.all(events.map(mapDbEventRow))
  return mapped.filter((event): event is OperationEvent => event !== null)
}

export async function buildOperationsFromEvents(
  chrono: readonly OperationEvent[],
  opts: ListOperationsOpts = {}
): Promise<OperationPipeline[]> {
  const previewToPlan = buildPreviewToPlanMap(chrono)
  const buckets = correlateEventsIntoBuckets(chrono, previewToPlan)
  const built = await filterOperations(await buildPipelinesFromBuckets(buckets.values()), opts)
  const syncMerged = await mergeSyncPlanPipelines(built)
  const runIds = syncMerged.map((operation) => operation.id)
  const runs = new Map(
    await Promise.all(
      runIds.map(async (runId) => [runId, await db.getRun(runId)] as const),
    ),
  )
  const resumeChildren = new Map(
    await Promise.all(
      runIds.map(async (runId) => [runId, await db.runHasResumeChild(runId)] as const),
    ),
  )
  const rootMeta = new Map<string, { startedAt: string; title: string } | null>()
  for (const runId of runIds) {
    let cur = runs.get(runId) ?? await db.getRun(runId)
    if (!cur) {
      rootMeta.set(runId, null)
      continue
    }
    const guard = new Set<string>()
    while (cur.parent_run_id && !guard.has(cur.id)) {
      guard.add(cur.id)
      const parent = await db.getRun(cur.parent_run_id)
      if (!parent) break
      cur = parent
    }
    const goal = cur.goal
    rootMeta.set(runId, {
      startedAt: cur.created_at,
      title: goal.length > 100 ? `${goal.slice(0, 97)}…` : goal,
    })
  }
  return mergeAgentRunResumePipelines(syncMerged, {
    parentRunId: (runId) => runs.get(runId)?.parent_run_id ?? null,
    hasResumeChild: (runId) => resumeChildren.get(runId) ?? false,
    rootMeta: (runId) => rootMeta.get(runId) ?? null,
  })
}
