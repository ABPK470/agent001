/**
 * Merge sync-preview + sync-execute pipelines into one sync-run row for the live feed.
 */

import { OperationKind, OperationStatus } from "../../../../shared/enums/operations.js"
import type { OperationActivity, OperationPipeline } from "./types.js"
import { durationOf } from "./utils.js"

function planIdFromPipeline(op: OperationPipeline): string {
  return op.planId ?? op.id.replace(/:(preview|execute)$/, "")
}

function phaseFromPipeline(
  id: "phase:preview" | "phase:execute",
  name: string,
  pipe: OperationPipeline
): OperationActivity {
  const lifecycleSummary =
    pipe.activities.find((a) => a.name === "completed")?.summary ??
    pipe.activities.find((a) => a.name === "Execute skipped")?.summary ??
    pipe.activities.find((a) => a.name === "failed")?.summary

  return {
    id,
    name,
    status: pipe.status,
    startedAt: pipe.startedAt,
    endedAt: pipe.endedAt,
    durationMs: pipe.durationMs,
    summary: lifecycleSummary,
    error: pipe.error,
    events: [],
    children: pipe.activities
  }
}

function buildSyncRunFromParts(
  planId: string,
  preview: OperationPipeline | undefined,
  execute: OperationPipeline | undefined
): OperationPipeline {
  const phases: OperationActivity[] = []
  if (preview) phases.push(phaseFromPipeline("phase:preview", "Preview", preview))
  if (execute) phases.push(phaseFromPipeline("phase:execute", "Execute", execute))

  const primary = execute ?? preview!
  const startedAt = preview?.startedAt ?? execute!.startedAt
  const endedAt = execute?.endedAt ?? preview?.endedAt ?? null

  let status: OperationStatus = primary.status
  if (preview && execute) {
    if (execute.status === OperationStatus.Failed || preview.status === OperationStatus.Failed) {
      status = OperationStatus.Failed
    } else if (execute.status === OperationStatus.Skipped) {
      status = OperationStatus.Skipped
    } else if (execute.status === OperationStatus.Running || preview.status === OperationStatus.Running) {
      status = OperationStatus.Running
    } else if (execute.status === OperationStatus.Success && preview.status === OperationStatus.Success) {
      status = OperationStatus.Success
    } else {
      status = execute.status
    }
  }

  return {
    id: planId,
    planId,
    kind: OperationKind.SyncRun,
    title: primary.title.replace(/^(Preview|Execute) /, "Sync "),
    subtitle: primary.subtitle,
    status,
    startedAt,
    endedAt,
    durationMs: durationOf(startedAt, endedAt) ?? primary.durationMs,
    activityCount: phases.length,
    eventCount: (preview?.eventCount ?? 0) + (execute?.eventCount ?? 0),
    error: execute?.error ?? preview?.error,
    activities: phases
  }
}

/** Collapse paired preview/execute rows into unified sync-run pipelines. */
export function mergeSyncPlanPipelines(operations: OperationPipeline[]): OperationPipeline[] {
  const groups = new Map<string, { preview?: OperationPipeline; execute?: OperationPipeline }>()
  const rest: OperationPipeline[] = []

  for (const op of operations) {
    if (op.kind === OperationKind.SyncPreview || op.kind === OperationKind.SyncExecute) {
      const planId = planIdFromPipeline(op)
      const group = groups.get(planId) ?? {}
      if (op.kind === OperationKind.SyncPreview) group.preview = op
      else group.execute = op
      groups.set(planId, group)
    } else {
      rest.push(op)
    }
  }

  const merged: OperationPipeline[] = [...rest]
  for (const [planId, { preview, execute }] of groups) {
    if (!preview && !execute) continue
    merged.push(buildSyncRunFromParts(planId, preview, execute))
  }

  merged.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  return merged
}
