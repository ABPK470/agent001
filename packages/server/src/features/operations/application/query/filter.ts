/**
 * Apply optional query filters (kind, status, free-text search) after pipelines are built.
 */

import type { ListOperationsOpts, OperationPipeline } from "./types.js"

export function filterOperations(
  operations: OperationPipeline[],
  opts: ListOperationsOpts
): OperationPipeline[] {
  let filtered = operations

  if (opts.kind && opts.kind !== "all") {
    filtered = filtered.filter((p) => p.kind === opts.kind)
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
