/**
 * Apply optional query filters (kind, status, free-text search) after pipelines are built.
 * Personal scope: pipelines owned by Viewing as (actorUpn / run.upn / sync actor_upn).
 */

import { OperationKind } from "../../../../internal/enums/operations.js"
import * as db from "../../../../infra/persistence/sqlite.js"
import type { ListOperationsOpts, OperationPipeline } from "./types.js"

function matchesKindFilter(pipeline: OperationPipeline, kind: string): boolean {
  if (kind === "all") return true
  if (kind === "agent") return pipeline.kind === OperationKind.AgentRun
  if (kind === "sync") {
    return (
      pipeline.kind === OperationKind.SyncRun ||
      pipeline.kind === OperationKind.SyncPreview ||
      pipeline.kind === OperationKind.SyncExecute ||
      pipeline.kind === OperationKind.ProposerRun
    )
  }
  if (kind === "bridge") {
    return (
      pipeline.kind === OperationKind.BridgePreview ||
      pipeline.kind === OperationKind.BridgeRun
    )
  }
  return pipeline.kind === kind
}

function sameUpn(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = a?.trim().toLowerCase()
  const right = b?.trim().toLowerCase()
  return Boolean(left && right && left === right)
}

/** Resolve owner for scoping — prefer stamped actorUpn, else persistence lookup. */
export function pipelineOwnerUpn(pipeline: OperationPipeline): string | null {
  if (pipeline.actorUpn?.trim()) return pipeline.actorUpn.trim()

  if (pipeline.kind === OperationKind.AgentRun) {
    return db.getRun(pipeline.id)?.upn?.trim() || null
  }

  if (
    pipeline.kind === OperationKind.SyncRun ||
    pipeline.kind === OperationKind.SyncPreview ||
    pipeline.kind === OperationKind.SyncExecute
  ) {
    const planId = pipeline.planId ?? pipeline.id
    return db.getSyncRun(planId)?.actor_upn?.trim() || null
  }

  // Bridge / proposer / unknown without stamp — fail closed.
  return null
}

export function scopeOperationsToViewer(
  operations: OperationPipeline[],
  opts: Pick<ListOperationsOpts, "viewerUpn">,
): OperationPipeline[] {
  // No viewer context (unit tests / internal callers) — leave unscoped.
  if (opts.viewerUpn === undefined) return operations
  const viewer = opts.viewerUpn.trim()
  if (!viewer) return []
  return operations.filter((p) => sameUpn(pipelineOwnerUpn(p), viewer))
}

export function excludeSystemPipelines(operations: OperationPipeline[]): OperationPipeline[] {
  return operations.filter((p) => p.kind !== OperationKind.System)
}

export function filterOperations(
  operations: OperationPipeline[],
  opts: ListOperationsOpts
): OperationPipeline[] {
  let filtered = operations

  if (opts.kind && opts.kind !== "all") {
    filtered = filtered.filter((p) => matchesKindFilter(p, opts.kind!))
  }
  if (opts.status && opts.status !== "all") {
    filtered = filtered.filter((p) => p.status === opts.status)
  }
  if (opts.search) {
    const needle = opts.search.toLowerCase()
    filtered = filtered.filter(
      (p) =>
        p.title.toLowerCase().includes(needle) ||
        (p.subtitle ?? "").toLowerCase().includes(needle) ||
        p.id.toLowerCase().includes(needle) ||
        (p.error ?? "").toLowerCase().includes(needle) ||
        p.activities.some(
          (a) =>
            a.name.toLowerCase().includes(needle) ||
            (a.summary ?? "").toLowerCase().includes(needle) ||
            (a.error ?? "").toLowerCase().includes(needle) ||
            a.events.some((e) => e.type.toLowerCase().includes(needle))
        )
    )
  }

  return scopeOperationsToViewer(filtered, opts)
}
