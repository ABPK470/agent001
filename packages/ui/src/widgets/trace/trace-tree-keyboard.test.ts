import { describe, expect, it } from "vitest"
import type { TraceTreeNode } from "./trace-tree-index"
import {
  adjacentTreeIndex,
  firstChildIndex,
  parentIndex,
  resolveTreeKeyboardAction,
} from "./trace-tree-keyboard"

function node(
  partial: Pick<TraceTreeNode, "scopeId" | "parentScopeId" | "hasChildren" | "depth">,
): TraceTreeNode {
  return {
    kind: "work",
    name: partial.scopeId,
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
    callIndex: null,
    workId: null,
    phaseId: null,
    toolKey: null,
    messageKey: null,
    ...partial,
  }
}

describe("trace-tree-keyboard", () => {
  it("moves up/down through the visible list", () => {
    expect(adjacentTreeIndex(3, 1, 1)).toBe(2)
    expect(adjacentTreeIndex(3, 0, -1)).toBe(0)
    expect(adjacentTreeIndex(3, -1, 1)).toBe(0)
    expect(adjacentTreeIndex(3, -1, -1)).toBe(2)
  })

  it("finds first child and parent in the flat list", () => {
    const nodes = [
      node({ scopeId: "call:0", parentScopeId: null, hasChildren: true, depth: 0 }),
      node({ scopeId: "sent:0", parentScopeId: "call:0", hasChildren: false, depth: 1 }),
      node({ scopeId: "work:1", parentScopeId: null, hasChildren: false, depth: 0 }),
    ]
    expect(firstChildIndex(nodes, 0)).toBe(1)
    expect(parentIndex(nodes, 1)).toBe(0)
    expect(firstChildIndex(nodes, 2)).toBe(-1)
  })

  it("ArrowRight expands a folded branch; ArrowLeft collapses an open one", () => {
    const nodes = [
      node({ scopeId: "call:0", parentScopeId: null, hasChildren: true, depth: 0 }),
    ]
    expect(
      resolveTreeKeyboardAction("ArrowRight", nodes, "call:0", () => true),
    ).toEqual({ type: "toggleFold", scopeId: "call:0" })
    expect(
      resolveTreeKeyboardAction("ArrowLeft", nodes, "call:0", () => false),
    ).toEqual({ type: "toggleFold", scopeId: "call:0" })
  })

  it("ArrowDown selects the next visible row", () => {
    const nodes = [
      node({ scopeId: "a", parentScopeId: null, hasChildren: false, depth: 0 }),
      node({ scopeId: "b", parentScopeId: null, hasChildren: false, depth: 0 }),
    ]
    expect(resolveTreeKeyboardAction("ArrowDown", nodes, "a", () => false)).toEqual({
      type: "select",
      scopeId: "b",
      index: 1,
    })
  })
})
