import { describe, expect, it } from "vitest"
import { buildTraceDag } from "./build-trace-dag"
import { emptyOpen } from "./open-state"
import {
    buildTraceTreeIndex,
    findDeepestFailure,
    resolveSelectionScopeId,
} from "./trace-tree-index"

function failedBuildDag() {
  return buildTraceDag([
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
}

describe("trace-tree-index", () => {
  it("finds deepest failure under a phase branch", () => {
    const dag = failedBuildDag()
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
      const deepest = findDeepestFailure(index, phase.scopeId, dag)
      expect(deepest).toBe(work?.scopeId)
      expect(resolveSelectionScopeId(index, phase.scopeId, true, dag)).toBe(work?.scopeId)
    }
  })

  it("does not Err-badge a phase that ended successfully after a recovered tool error", () => {
    const dag = failedBuildDag()
    // Force the work's parent phase (if any) / work itself: when a phase is done,
    // historical tool errors must not keep the phase badge on Err.
    const open = emptyOpen()
    open.calls.add(0)
    for (const entry of dag.spine) {
      if (entry.kind === "phase") {
        open.phases.add(entry.phase.id)
        entry.phase.status = "done"
        for (const child of entry.phase.children ?? []) {
          if (child.kind === "work") open.work.add(child.work.id)
        }
      }
    }
    const index = buildTraceTreeIndex(dag, open, null)
    const phase = index.nodes.find((n) => n.kind === "phase")
    if (phase) {
      expect(phase.status).toBe("success")
      expect(phase.branchHasError).toBe(false)
      expect(phase.hasError).toBe(false)
    }
    const work = index.nodes.find((n) => n.kind === "work" && n.hasError)
    expect(work?.hasError).toBe(true)
  })

  it("shows prompt and tools under Context when preamble is expanded", () => {
    const dag = buildTraceDag([
      { kind: "system-prompt", text: "You are helpful." },
      {
        kind: "tools-resolved",
        tools: [{ name: "search", description: "Search the web", parameters: {} }],
      },
      { kind: "llm-request", iteration: 0, messageCount: 1, toolCount: 1, messages: [] },
      {
        kind: "llm-response",
        iteration: 0,
        durationMs: 50,
        content: "ok",
        toolCalls: [],
        usage: null,
      },
    ])
    const collapsed = buildTraceTreeIndex(dag, emptyOpen(), null)
    expect(collapsed.byScopeId.has("context")).toBe(true)
    expect(collapsed.byScopeId.has("prompt")).toBe(false)
    expect(collapsed.byScopeId.has("tools")).toBe(false)

    const open = emptyOpen()
    open.preamble = true
    const expanded = buildTraceTreeIndex(dag, open, null)
    expect(expanded.byScopeId.has("prompt")).toBe(true)
    expect(expanded.byScopeId.has("tools")).toBe(true)
  })

  it("marks user-cancel fatal nudge as cancelled, not OK, without a hollow chevron", () => {
    const dag = buildTraceDag([
      { kind: "system-prompt", text: "sys" },
      { kind: "llm-request", iteration: 0, messageCount: 1, toolCount: 0, messages: [] },
      {
        kind: "llm-response",
        iteration: 0,
        durationMs: 40,
        content: "working",
        toolCalls: [],
        usage: null,
      },
      {
        kind: "nudge",
        tag: "fatal-tool-outcome",
        message: "Agent was cancelled.",
        iteration: 0,
      },
    ])
    const open = emptyOpen()
    open.calls.add(0)
    for (const entry of dag.spine) {
      if (entry.kind === "work") open.work.add(entry.work.id)
    }
    const index = buildTraceTreeIndex(dag, open, null)
    const work = index.nodes.find((n) => n.kind === "work")
    expect(work?.name).toBe("Cancelled")
    expect(work?.status).toBe("cancelled")
    expect(work?.hasError).toBe(false)
    expect(work?.hasChildren).toBe(false)
  })

  it("keeps parent branchHasError when the failing child is folded away", () => {
    const dag = failedBuildDag()
    const open = emptyOpen()
    open.calls.add(0)
    open.received.add(0)
    for (const entry of dag.spine) {
      if (entry.kind === "phase") {
        open.phases.add(entry.phase.id)
        for (const child of entry.phase.children ?? []) {
          if (child.kind === "work") open.work.add(child.work.id)
          if (child.kind === "phase") open.phases.add(child.phase.id)
          if (child.kind === "call") {
            open.calls.add(child.callIndex)
            open.received.add(child.callIndex)
          }
        }
      }
      if (entry.kind === "work") open.work.add(entry.work.id)
    }

    const expanded = buildTraceTreeIndex(dag, open, null)
    const branchParent = expanded.nodes.find(
      (n) => n.hasChildren && n.branchHasError && !n.hasError,
    )
    // Prefer a rollup parent (phase/call/received). Fall back to any errored work.
    const parent =
      branchParent ?? expanded.nodes.find((n) => n.kind === "work" && n.hasError)
    expect(parent).toBeTruthy()

    const collapsed = buildTraceTreeIndex(dag, emptyOpen(), null)
    const parentCollapsed = collapsed.byScopeId.get(parent!.scopeId)
    expect(parentCollapsed).toBeTruthy()

    // Children that carry the failure are gone when folded — parent flag must not flip.
    const expandedKids = expanded.childrenByParent.get(parent!.scopeId) ?? []
    const collapsedKids = collapsed.childrenByParent.get(parent!.scopeId) ?? []
    if (parent!.kind !== "work") {
      expect(expandedKids.length).toBeGreaterThan(collapsedKids.length)
      expect(parentCollapsed!.branchHasError).toBe(true)
      expect(parent!.branchHasError).toBe(true)
    } else {
      expect(parentCollapsed!.hasError).toBe(true)
    }
  })
})
