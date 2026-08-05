import { describe, expect, it } from "vitest"
import type { OperationPipeline } from "../client/index"
import { OperationKind, OperationStatus } from "../client/index"
import { flattenOperationRows } from "./operation-flat-rows"
import {
  buildOperationLogKeyboardNodes,
  selectedScopeIdFromOpLogSelection,
} from "./operation-log-keyboard-nodes"

function pipeline(id: string): OperationPipeline {
  return {
    id,
    kind: OperationKind.AgentRun,
    status: OperationStatus.Completed,
    title: id,
    startedAt: new Date().toISOString(),
    activities: [
      {
        id: "a1",
        name: "started",
        status: OperationStatus.Completed,
        startedAt: new Date().toISOString(),
        children: [],
        events: [],
      },
    ],
  }
}

describe("operation-log-keyboard-nodes", () => {
  it("skips day headers and maps pipeline/activity rows", () => {
    const rows = flattenOperationRows(
      [pipeline("p1"), pipeline("p2")],
      new Set(),
      () => "Today",
    )
    const nodes = buildOperationLogKeyboardNodes(rows)
    expect(nodes.some((n) => n.scopeId.startsWith("day:"))).toBe(false)
    expect(nodes.map((n) => n.scopeId)).toEqual(["p1", "p2"])
  })

  it("maps selection to keyboard scope ids", () => {
    expect(
      selectedScopeIdFromOpLogSelection({ kind: "pipeline", pipelineId: "p1" }),
    ).toBe("p1")
    expect(
      selectedScopeIdFromOpLogSelection({
        kind: "activity",
        pipelineId: "p1",
        activityKey: "p1:a1",
      }),
    ).toBe("p1:a1")
  })
})
