/**
 * Resolve tool spans from tree keys — shared by detail panel + inspector header.
 */

import type { TraceDag, TraceToolCall } from "./build-trace-dag"
import { callToolOpenKey, workToolOpenKey } from "./open-state"

export function resolveTraceTool(dag: TraceDag, toolKey: string): TraceToolCall | null {
  for (const call of dag.calls) {
    for (const tool of call.toolBranches) {
      if (callToolOpenKey(call.index, tool.id) === toolKey) return tool
    }
  }
  for (const entry of dag.spine) {
    const works =
      entry.kind === "work"
        ? [entry.work]
        : entry.kind === "phase"
          ? (entry.phase.children ?? [])
              .filter((c): c is Extract<typeof c, { kind: "work" }> => c.kind === "work")
              .map((c) => c.work)
          : []
    for (const work of works) {
      for (const tool of work.tools) {
        if (workToolOpenKey(work.id, tool.id) === toolKey) return tool
      }
    }
  }
  return null
}

export function traceToolCurl(tool: TraceToolCall): string | null {
  if (!tool.name) return null
  return `curl -X POST '/api/tools/${tool.name}' -H 'Content-Type: application/json' -d '${JSON.stringify(tool.arguments)}'`
}
