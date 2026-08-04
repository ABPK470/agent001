/**
 * Resolve tool spans from tree keys — shared by detail panel + inspector header.
 */

import type { TraceDag, TraceToolCall, TraceWorkNode } from "./build-trace-dag"
import { callToolOpenKey, workToolOpenKey } from "./open-state"

function collectWorks(
  phase: import("./build-trace-dag").TracePhaseNode,
  works: TraceWorkNode[],
) {
  for (const child of phase.children ?? []) {
    if (child.kind === "work") works.push(child.work)
    else if (child.kind === "phase") collectWorks(child.phase, works)
  }
}

function workToolsFromSpine(dag: TraceDag): TraceWorkNode[] {
  const works: TraceWorkNode[] = []
  for (const entry of dag.spine) {
    if (entry.kind === "work") works.push(entry.work)
    if (entry.kind === "phase") collectWorks(entry.phase, works)
  }
  return works
}

export function resolveTraceWorkForTool(dag: TraceDag, toolKey: string): TraceWorkNode | null {
  for (const work of workToolsFromSpine(dag)) {
    for (const tool of work.tools) {
      if (workToolOpenKey(work.id, tool.id) === toolKey) return work
    }
  }
  return null
}

export function resolveTraceTool(dag: TraceDag, toolKey: string): TraceToolCall | null {
  for (const call of dag.calls) {
    for (const tool of call.toolBranches) {
      if (callToolOpenKey(call.index, tool.id) === toolKey) return tool
    }
  }
  for (const work of workToolsFromSpine(dag)) {
    for (const tool of work.tools) {
      if (workToolOpenKey(work.id, tool.id) === toolKey) return tool
    }
  }
  return null
}

export function traceToolCurl(tool: TraceToolCall): string | null {
  if (!tool.name) return null
  return `curl -X POST '/api/tools/${tool.name}' -H 'Content-Type: application/json' -d '${JSON.stringify(tool.arguments)}'`
}
