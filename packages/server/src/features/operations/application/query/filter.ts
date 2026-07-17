/**
 * Apply optional query filters (kind, status, free-text search) after pipelines are built.
 */

import { OperationKind } from "../../../../shared/enums/operations.js"
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

  return filtered
}
