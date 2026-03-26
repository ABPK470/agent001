import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { StepStatus, WorkflowStatus } from "../../src/domain/enums.js"
import { DomainError } from "../../src/domain/errors.js"
import type { Workflow } from "../../src/domain/models.js"
import type { WorkflowDefinition } from "../../src/domain/workflow-schema.js"
import { planSteps } from "../../src/engine/planner.js"

function wf(
  def: Partial<WorkflowDefinition> & { steps: WorkflowDefinition["steps"] },
): Workflow {
  return {
    id: randomUUID(),
    status: WorkflowStatus.Active,
    definition: { name: "W", description: "", inputSchema: {}, ...def },
    createdAt: new Date(),
  }
}

describe("planSteps", () => {
  it("produces steps in definition order when no dependencies", () => {
    const w = wf({
      steps: [
        { id: "a", name: "A", action: "do", input: {} },
        { id: "b", name: "B", action: "do", input: {} },
        { id: "c", name: "C", action: "do", input: {} },
      ],
    })
    const steps = planSteps(w, {})
    expect(steps.map((s) => s.definitionId)).toEqual(["a", "b", "c"])
    expect(steps.every((s) => s.status === StepStatus.Pending)).toBe(true)
  })

  it("respects dependsOn ordering", () => {
    const w = wf({
      steps: [
        { id: "c", name: "C", action: "do", input: {}, dependsOn: ["a", "b"] },
        { id: "a", name: "A", action: "do", input: {} },
        { id: "b", name: "B", action: "do", input: {}, dependsOn: ["a"] },
      ],
    })
    const steps = planSteps(w, {})
    const ids = steps.map((s) => s.definitionId)
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"))
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("c"))
  })

  it("carries condition and onError from definition", () => {
    const w = wf({
      steps: [
        {
          id: "s1",
          name: "S1",
          action: "do",
          input: {},
          condition: "{{input.x}} > 5",
          onError: "skip",
        },
      ],
    })
    const steps = planSteps(w, {})
    expect(steps[0].condition).toBe("{{input.x}} > 5")
    expect(steps[0].onError).toBe("skip")
  })

  it("throws on circular dependencies", () => {
    const w = wf({
      steps: [
        { id: "a", name: "A", action: "do", input: {}, dependsOn: ["b"] },
        { id: "b", name: "B", action: "do", input: {}, dependsOn: ["a"] },
      ],
    })
    expect(() => planSteps(w, {})).toThrow(DomainError)
  })

  it("throws on unknown dependency", () => {
    const w = wf({
      steps: [
        {
          id: "a",
          name: "A",
          action: "do",
          input: {},
          dependsOn: ["nonexistent"],
        },
      ],
    })
    expect(() => planSteps(w, {})).toThrow(DomainError)
  })

  it("assigns sequential order", () => {
    const w = wf({
      steps: [
        { id: "a", name: "A", action: "do", input: {} },
        { id: "b", name: "B", action: "do", input: {} },
      ],
    })
    const steps = planSteps(w, {})
    expect(steps[0].order).toBe(0)
    expect(steps[1].order).toBe(1)
  })
})
