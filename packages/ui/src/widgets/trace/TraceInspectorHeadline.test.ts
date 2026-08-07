import { describe, expect, it } from "vitest"
import { headlineRow2Line, inspectorTitle } from "./TraceInspectorHeadline"
import type { TraceTreeNode } from "./trace-tree-index"

function node(partial: Partial<TraceTreeNode> & Pick<TraceTreeNode, "kind" | "name">): TraceTreeNode {
  return {
    scopeId: "x",
    depth: 0,
    subtitle: null,
    leading: null,
    durationMs: null,
    startOffsetMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: null,
    status: "success",
    hasError: false,
    branchHasError: false,
    hasChildren: false,
    parentScopeId: null,
    callIndex: null,
    workId: null,
    phaseId: null,
    toolKey: null,
    messageKey: null,
    ...partial,
  }
}

describe("inspectorTitle", () => {
  it("names Call rows like the left tree, with model in parentheses", () => {
    expect(
      inspectorTitle(
        node({
          kind: "call",
          leading: "Call 1",
          name: "ask_user",
          subtitle: "gpt-demo",
        }),
      ),
    ).toBe("Call 1 — ask_user (gpt-demo)")
  })

  it("does not invent a model suffix when unknown", () => {
    expect(
      inspectorTitle(node({ kind: "call", leading: "Call 2", name: "write_file" })),
    ).toBe("Call 2 — write_file")
  })
})

describe("headlineRow2Line", () => {
  it("keeps duration on the metrics line so the title row stays identity-only", () => {
    expect(
      headlineRow2Line(
        node({
          kind: "call",
          leading: "Call 1",
          name: "ask_user",
          durationMs: 420,
          promptTokens: 260,
          completionTokens: 110,
        }),
      ),
    ).toBe("420ms · 260 in / 110 out")
  })
})
