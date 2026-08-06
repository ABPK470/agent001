import { describe, expect, it } from "vitest"
import {
  adjacentTreeIndex,
  firstChildIndex,
  parentIndex,
  resolveReviewTreeKeyboardAction,
  type ReviewTreeKeyboardNode,
} from "./resolve-review-tree-keyboard"

function node(
  partial: Pick<ReviewTreeKeyboardNode, "scopeId" | "parentScopeId" | "hasChildren" | "flatIndex">,
): ReviewTreeKeyboardNode {
  return { ...partial }
}

describe("review-tree-keyboard", () => {
  it("moves up/down through the visible list", () => {
    expect(adjacentTreeIndex(3, 1, 1)).toBe(2)
    expect(adjacentTreeIndex(3, 0, -1)).toBe(0)
    expect(adjacentTreeIndex(3, -1, 1)).toBe(0)
    expect(adjacentTreeIndex(3, -1, -1)).toBe(2)
  })

  it("finds first child and parent in the flat list", () => {
    const nodes = [
      node({ scopeId: "call:0", parentScopeId: null, hasChildren: true, flatIndex: 0 }),
      node({ scopeId: "sent:0", parentScopeId: "call:0", hasChildren: false, flatIndex: 1 }),
      node({ scopeId: "work:1", parentScopeId: null, hasChildren: false, flatIndex: 2 }),
    ]
    expect(firstChildIndex(nodes, 0)).toBe(1)
    expect(parentIndex(nodes, 1)).toBe(0)
    expect(firstChildIndex(nodes, 2)).toBe(-1)
  })

  it("ArrowRight expands a folded branch; ArrowLeft collapses an open one", () => {
    const nodes = [
      node({ scopeId: "call:0", parentScopeId: null, hasChildren: true, flatIndex: 0 }),
    ]
    expect(
      resolveReviewTreeKeyboardAction("ArrowRight", nodes, "call:0", () => true),
    ).toEqual({ type: "toggleFold", scopeId: "call:0" })
    expect(
      resolveReviewTreeKeyboardAction("ArrowLeft", nodes, "call:0", () => false),
    ).toEqual({ type: "toggleFold", scopeId: "call:0" })
  })

  it("ArrowDown selects the next visible row", () => {
    const nodes = [
      node({ scopeId: "a", parentScopeId: null, hasChildren: false, flatIndex: 0 }),
      node({ scopeId: "b", parentScopeId: null, hasChildren: false, flatIndex: 3 }),
    ]
    expect(resolveReviewTreeKeyboardAction("ArrowDown", nodes, "a", () => false)).toEqual({
      type: "select",
      scopeId: "b",
      flatIndex: 3,
    })
  })
})
