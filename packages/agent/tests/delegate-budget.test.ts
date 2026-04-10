import { describe, expect, it } from "vitest"

import type { ExecutionEnvelope, SubagentTaskStep } from "../src/planner/types.js"
import { computePlannerChildBudgetMetrics, computePlannerChildMaxIterations } from "../src/tools/delegate.js"

function makeEnvelope(overrides: Partial<ExecutionEnvelope> = {}): ExecutionEnvelope {
  return {
    workspaceRoot: ".",
    allowedReadRoots: ["."],
    allowedWriteRoots: ["."],
    allowedTools: ["read_file", "write_file", "replace_in_file", "browser_check"],
    requiredSourceArtifacts: [],
    targetArtifacts: ["tmp/output.js"],
    effectClass: "filesystem_write",
    verificationMode: "none",
    artifactRelations: [],
    role: "writer",
    ...overrides,
  }
}

function makeStep(overrides: Partial<SubagentTaskStep> = {}): SubagentTaskStep {
  return {
    name: "implement_step",
    stepType: "subagent_task",
    objective: "Implement the requested feature completely",
    inputContract: "Goal and workspace",
    acceptanceCriteria: ["Feature works end-to-end"],
    requiredToolCapabilities: ["read_file", "write_file"],
    contextRequirements: [],
    executionContext: makeEnvelope(),
    maxBudgetHint: "20 iterations",
    canRunParallel: false,
    ...overrides,
  }
}

describe("computePlannerChildMaxIterations", () => {
  it("raises budgets sharply for complex cohesive logic steps", () => {
    const step = makeStep({
      objective: "Implement the complete chess game rules engine with full move validation and king safety",
      acceptanceCriteria: [
        "Validates legal moves for all piece types",
        "Implements castling correctly",
        "Implements en passant correctly",
        "Implements promotion correctly",
        "Rejects moves that leave the king in check",
        "Detects checkmate and stalemate",
      ],
      maxBudgetHint: "20 iterations",
    })
    const envelope = makeEnvelope({
      requiredSourceArtifacts: ["tmp/BLUEPRINT.md", "tmp/index.html"],
      targetArtifacts: ["tmp/game_logic.js"],
      verificationMode: "none",
    })

    const metrics = computePlannerChildBudgetMetrics(step, envelope)
    expect(metrics.hasComplexImplementation).toBe(true)
    expect(metrics.hasBlueprintSource).toBe(true)
    expect(metrics.complexityBoost).toBeGreaterThan(0)
    expect(metrics.computedMaxIterations).toBeGreaterThanOrEqual(90)
    expect(computePlannerChildMaxIterations(step, envelope)).toBe(metrics.computedMaxIterations)
  })

  it("keeps simple writer steps near the default budget", () => {
    const step = makeStep({
      objective: "Create a small utility module",
      acceptanceCriteria: ["Exports a helper function"],
      maxBudgetHint: "20 iterations",
    })
    const envelope = makeEnvelope({
      targetArtifacts: ["tmp/helpers.js"],
    })

    const metrics = computePlannerChildBudgetMetrics(step, envelope)
    expect(metrics.hasComplexImplementation).toBe(false)
    expect(metrics.computedMaxIterations).toBeGreaterThanOrEqual(50)
    expect(metrics.computedMaxIterations).toBeLessThanOrEqual(70)
  })

  it("respects explicit high hints but still caps at the hard ceiling", () => {
    const step = makeStep({
      objective: "Implement complex workflow engine and validators",
      acceptanceCriteria: [
        "Handles all workflow transitions",
        "Enforces constraint validation",
        "Persists derived state consistently",
        "Rejects invalid transitions",
        "Produces deterministic outputs",
        "Supports recovery from partial failures",
        "Exposes readable diagnostics",
        "Matches blueprint contracts exactly",
      ],
      maxBudgetHint: "160 iterations",
    })
    const envelope = makeEnvelope({
      requiredSourceArtifacts: ["tmp/BLUEPRINT.md", "tmp/model.ts", "tmp/types.ts", "tmp/state.ts"],
      targetArtifacts: ["tmp/engine.ts", "tmp/validators.ts"],
      verificationMode: "run_tests",
    })

    const metrics = computePlannerChildBudgetMetrics(step, envelope)
    expect(metrics.computedMaxIterations).toBeGreaterThanOrEqual(160)
    expect(metrics.computedMaxIterations).toBeLessThanOrEqual(180)
    expect(metrics.contractFloor).toBeGreaterThanOrEqual(18)
  })
})