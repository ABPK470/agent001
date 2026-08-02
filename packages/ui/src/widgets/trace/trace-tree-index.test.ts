import { describe, expect, it } from "vitest"
import { buildTraceDag } from "./build-trace-dag"
import { emptyOpen } from "./open-state"
import {
    buildTraceTreeIndex,
    findDeepestFailure,
    resolveSelectionScopeId,
} from "./trace-tree-index"

describe("trace-tree-index", () => {
  it("finds deepest failure under a phase branch", () => {
    const dag = buildTraceDag([
      { kind: "system-prompt", text: "sys" },
      { kind: "llm-request", iteration: 0, messageCount: 1, toolCount: 0, messages: [] },
      {
        kind: "llm-response",
        iteration: 0,
        durationMs: 100,
        content: null,
        toolCalls: [{ id: "t1", name: "run_build", arguments: {} }],
        usage: null,
      },
      {
        kind: "tool-call",
        invocationId: "i1",
        toolCallId: "t1",
        tool: "run_build",
        argsSummary: "",
        argsFormatted: "{}",
      },
      {
        kind: "tool-error",
        invocationId: "i1",
        toolCallId: "t1",
        text: "Build failed at line 42",
      },
    ])
    const open = emptyOpen()
    open.calls.add(0)
    const index = buildTraceTreeIndex(dag, open, null)
    const phase = index.nodes.find((n) => n.kind === "phase")
    const work = index.nodes.find((n) => n.kind === "work")
    expect(work?.hasError).toBe(true)
    if (phase) {
      expect(phase.branchHasError).toBe(true)
      if (phase.subtitle === "done" || phase.subtitle?.endsWith("done")) {
        expect(phase.subtitle).toMatch(/^failed —/)
      }
      const deepest = findDeepestFailure(index, phase.scopeId)
      expect(deepest).toBe(work?.scopeId)
      expect(resolveSelectionScopeId(index, phase.scopeId, true)).toBe(work?.scopeId)
    }
  })
})
