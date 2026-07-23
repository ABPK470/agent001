import { describe, expect, it } from "vitest"
import { buildTraceDag } from "../../lib/events/build-trace-view.js"

describe("planner step phases — no orphan status parents", () => {
  it("does not spawn a second parent card for post-verify step-transitions", () => {
    const dag = buildTraceDag([
      { kind: "planner-step-start", stepName: "frontend_layer", stepType: "subagent_task" },
      {
        kind: "planner-step-end",
        stepName: "frontend_layer",
        status: "completed",
        acceptanceState: "accepted",
        durationMs: 100,
      },
      {
        kind: "planner-step-transition",
        attempt: 1,
        stepName: "frontend_layer",
        phase: "execution",
        state: "accepted",
        timestamp: 1,
      },
      {
        kind: "planner-verification",
        overall: "pass",
        confidence: 0.9,
        steps: [{ stepName: "frontend_layer", outcome: "pass", issues: [] }],
      },
      {
        kind: "planner-step-transition",
        attempt: 1,
        stepName: "frontend_layer",
        phase: "verification",
        state: "accepted",
        timestamp: 2,
      },
    ])

    const stepPhases = dag.spine.filter(
      (e) => e.kind === "phase" && e.phase.family === "step:frontend_layer",
    )
    // One logical step attempt → one parent card (not done + verification·accepted).
    expect(stepPhases).toHaveLength(1)
    if (stepPhases[0]?.kind === "phase") {
      expect(stepPhases[0].phase.id).toBe("phase-step:frontend_layer:1")
      // Transitions after verify must land on the same card, not a twin.
      expect(stepPhases[0].phase.details.some((d) => d.kind === "event" && d.text.includes("verification"))).toBe(
        true,
      )
    }
  })

  it("keeps distinct attempt cards when the same step starts again after verify", () => {
    const dag = buildTraceDag([
      { kind: "planner-step-start", stepName: "frontend_layer", stepType: "subagent_task" },
      {
        kind: "planner-step-end",
        stepName: "frontend_layer",
        status: "completed",
        acceptanceState: "repair_required",
        durationMs: 100,
      },
      {
        kind: "planner-verification",
        overall: "retry",
        confidence: 0.5,
        steps: [{ stepName: "frontend_layer", outcome: "retry", issues: ["gap"] }],
      },
      {
        kind: "planner-step-transition",
        attempt: 1,
        stepName: "frontend_layer",
        phase: "verification",
        state: "repair_required",
        timestamp: 2,
      },
      {
        kind: "planner-step-transition",
        attempt: 2,
        stepName: "frontend_layer",
        phase: "repair",
        state: "rewrite",
        timestamp: 3,
      },
      { kind: "planner-step-start", stepName: "frontend_layer", stepType: "subagent_task" },
      {
        kind: "planner-step-end",
        stepName: "frontend_layer",
        status: "completed",
        acceptanceState: "accepted",
        durationMs: 80,
      },
    ])

    const stepPhases = dag.spine.filter(
      (e) => e.kind === "phase" && e.phase.family.startsWith("step:frontend_layer"),
    )
    // Attempt 1 + attempt 2 only — status transitions must not add orphan parents.
    expect(stepPhases.length).toBe(2)
    expect(new Set(stepPhases.map((e) => (e.kind === "phase" ? e.phase.id : ""))).size).toBe(2)
  })
})
