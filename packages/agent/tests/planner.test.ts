/**
 * Planner subsystem tests — decision routing, plan validation,
 * pipeline execution, and circuit breaker behavior.
 */
import { describe, expect, it } from "vitest"
import { ToolFailureCircuitBreaker } from "../src/circuit-breaker.js"
import { assessPlannerDecision } from "../src/planner/decision.js"
import { executePipeline } from "../src/planner/pipeline.js"
import type { Plan, SubagentTaskStep } from "../src/planner/types.js"
import { validatePlan } from "../src/planner/validate.js"
import { extractCriterionKeywords } from "../src/planner/verifier.js"
import type { Tool } from "../src/types.js"

// ── Helpers ──────────────────────────────────────────────────────

function echoTool(name = "echo"): Tool {
  return {
    name,
    description: `Echo: ${name}`,
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
    },
    async execute(args) {
      return `echoed: ${String(args.text)}`
    },
  }
}

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    reason: "test plan",
    confidence: 0.9,
    requiresSynthesis: false,
    steps: [],
    edges: [],
    ...overrides,
  }
}

function makeSubagentStep(name: string, overrides: Partial<SubagentTaskStep> = {}): SubagentTaskStep {
  return {
    name,
    stepType: "subagent_task",
    objective: "Implement the game board with proper rendering and interaction",
    inputContract: "Empty workspace",
    acceptanceCriteria: ["Board renders correctly", "Pieces can be moved"],
    requiredToolCapabilities: ["write_file", "read_file"],
    contextRequirements: [],
    maxBudgetHint: "10 iterations",
    canRunParallel: false,
    executionContext: {
      workspaceRoot: ".",
      allowedReadRoots: ["."],
      allowedWriteRoots: ["."],
      allowedTools: ["write_file", "read_file"],
      requiredSourceArtifacts: [],
      targetArtifacts: ["game.js"],
      effectClass: "filesystem_write",
      verificationMode: "browser_check",
      artifactRelations: [],
    },
    ...overrides,
  }
}

// ============================================================================
// Planner decision tests
// ============================================================================

describe("Planner decision: assessPlannerDecision", () => {
  it("routes 'build a chess game' to planner (implementation scope)", () => {
    const decision = assessPlannerDecision("Build a fully playable chess game with drag and drop", [])
    expect(decision.shouldPlan).toBe(true)
    expect(decision.score).toBeGreaterThanOrEqual(3)
    expect(decision.reason).toContain("implementation_scope")
  })

  it("routes 'create a website with multiple pages' to planner", () => {
    const decision = assessPlannerDecision(
      "Create a website with a landing page, about page, and contact form. Build all pages and implement form validation.",
      [],
    )
    expect(decision.shouldPlan).toBe(true)
    expect(decision.score).toBeGreaterThanOrEqual(3)
  })

  it("routes 'build a todo app' to planner", () => {
    const decision = assessPlannerDecision("Build a complete todo application with add, delete, and filter functionality", [])
    expect(decision.shouldPlan).toBe(true)
  })

  it("routes 'first do X, then Y, then Z' to planner (multi-step)", () => {
    const decision = assessPlannerDecision(
      "First create the database schema, then implement the API endpoints, then write the frontend",
      [],
    )
    expect(decision.shouldPlan).toBe(true)
    expect(decision.reason).toContain("multi_step")
  })

  it("routes 'implement multiple components' to planner", () => {
    const decision = assessPlannerDecision(
      "Create multiple components for the dashboard: a chart widget, a data table, and a settings panel",
      [],
    )
    expect(decision.shouldPlan).toBe(true)
    expect(decision.score).toBeGreaterThanOrEqual(3)
  })

  it("keeps 'hello' in direct path (simple dialogue)", () => {
    const decision = assessPlannerDecision("hello", [])
    expect(decision.shouldPlan).toBe(false)
    expect(decision.reason).toBe("simple_dialogue")
  })

  it("keeps 'what is TypeScript?' in direct path (simple dialogue)", () => {
    const decision = assessPlannerDecision("what is TypeScript?", [])
    expect(decision.shouldPlan).toBe(false)
  })

  it("keeps short messages in direct path", () => {
    const decision = assessPlannerDecision("fix the bug", [])
    expect(decision.shouldPlan).toBe(false)
    expect(decision.reason).toBe("too_short")
  })

  it("keeps 'edit the login handler in auth.ts' in direct path", () => {
    const decision = assessPlannerDecision("Edit the login handler in auth.ts to add rate limiting", [])
    expect(decision.shouldPlan).toBe(false)
    expect(decision.reason).toBe("edit_artifact_direct_path")
  })

  it("keeps 'write a plan for the migration' in direct path", () => {
    const decision = assessPlannerDecision("Write a plan for the database migration", [])
    expect(decision.shouldPlan).toBe(false)
    // May match exact_response_turn or plan_generation_direct_path depending on gate order
    expect(["exact_response_turn", "plan_generation_direct_path"]).toContain(decision.reason)
  })

  it("keeps 'remember that I prefer TypeScript' in direct path", () => {
    const decision = assessPlannerDecision("Remember that I prefer TypeScript over JavaScript", [])
    expect(decision.shouldPlan).toBe(false)
    expect(decision.reason).toBe("dialogue_memory_turn")
  })

  it("routes with higher score when prior tool activity is high", () => {
    const history = Array.from({ length: 5 }, () => ({
      role: "tool" as const,
      content: "result",
    }))
    const decision = assessPlannerDecision("Now build a game application with these components", history)
    expect(decision.score).toBeGreaterThanOrEqual(5)
    expect(decision.reason).toContain("prior_tool_activity")
  })
})

// ============================================================================
// Plan validation tests
// ============================================================================

describe("Plan validation: validatePlan", () => {
  it("validates a well-formed plan with no diagnostics", () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("implement"),
        {
          name: "verify",
          stepType: "deterministic_tool",
          dependsOn: ["implement"],
          tool: "echo",
          args: { text: "check" },
        },
      ],
      edges: [{ from: "implement", to: "verify" }],
    })

    const result = validatePlan(plan, [echoTool()])
    expect(result.valid).toBe(true)
    expect(result.diagnostics).toHaveLength(0)
  })

  it("detects cycles in the dependency graph", () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("step-a", { dependsOn: ["step-b"] }),
        makeSubagentStep("step-b", { dependsOn: ["step-a"] }),
      ],
      edges: [
        { from: "step-a", to: "step-b" },
        { from: "step-b", to: "step-a" },
      ],
    })

    const result = validatePlan(plan, [echoTool()])
    expect(result.valid).toBe(false)
    expect(result.diagnostics.some(d => d.code === "cycle_detected")).toBe(true)
  })

  it("detects unknown tool references in deterministic steps", () => {
    const plan = makePlan({
      steps: [{
        name: "run-nonexistent",
        stepType: "deterministic_tool",
        tool: "nonexistent_tool",
        args: {},
      }],
      edges: [],
    })

    const result = validatePlan(plan, [echoTool()])
    expect(result.valid).toBe(false)
    expect(result.diagnostics.some(d => d.code === "unknown_tool")).toBe(true)
  })

  it("detects vague objective in subagent steps", () => {
    const plan = makePlan({
      steps: [makeSubagentStep("bad-step", { objective: "do it" })],
      edges: [],
    })

    const result = validatePlan(plan, [])
    expect(result.valid).toBe(false)
    expect(result.diagnostics.some(d => d.code === "vague_objective")).toBe(true)
  })

  it("detects missing acceptance criteria", () => {
    const plan = makePlan({
      steps: [makeSubagentStep("no-criteria", { acceptanceCriteria: [] })],
      edges: [],
    })

    const result = validatePlan(plan, [])
    expect(result.valid).toBe(false)
    expect(result.diagnostics.some(d => d.code === "missing_acceptance_criteria")).toBe(true)
  })

  it("detects multiple write owners for same artifact", () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("writer-1", {
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["game.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [{ relationType: "write_owner", artifactPath: "game.js" }],
          },
        }),
        makeSubagentStep("writer-2", {
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["game.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [{ relationType: "write_owner", artifactPath: "game.js" }],
          },
        }),
      ],
      edges: [],
    })

    const result = validatePlan(plan, [])
    expect(result.valid).toBe(false)
    expect(result.diagnostics.some(d => d.code === "multiple_write_owners")).toBe(true)
  })

  it("detects too many steps (>15)", () => {
    const steps = Array.from({ length: 16 }, (_, i) => makeSubagentStep(`step-${i}`))
    const plan = makePlan({ steps, edges: [] })

    const result = validatePlan(plan, [])
    expect(result.diagnostics.some(d => d.code === "too_many_steps")).toBe(true)
  })

  it("detects inconsistent output directories for same filename", () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("step-a", {
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["game/index.html"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
        makeSubagentStep("step-b", {
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/game/index.html"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
      ],
      edges: [],
    })

    const result = validatePlan(plan, [])
    expect(result.diagnostics.some(d => d.code === "inconsistent_output_directory")).toBe(true)
  })
})

// ============================================================================
// Pipeline execution tests
// ============================================================================

describe("Pipeline: executePipeline", () => {
  it("executes deterministic tool steps in order", async () => {
    const calls: string[] = []
    const tool: Tool = {
      name: "echo",
      description: "Echo",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      async execute(args) {
        const text = String(args.text)
        calls.push(text)
        return `done: ${text}`
      },
    }

    const plan = makePlan({
      steps: [
        { name: "step-1", stepType: "deterministic_tool", tool: "echo", args: { text: "first" } },
        { name: "step-2", stepType: "deterministic_tool", tool: "echo", args: { text: "second" }, dependsOn: ["step-1"] },
      ],
      edges: [{ from: "step-1", to: "step-2" }],
    })

    const result = await executePipeline(plan, [tool], async () => ({ output: "delegated" }))

    expect(result.status).toBe("completed")
    expect(calls).toEqual(["first", "second"])
  })

  it("skips downstream steps when upstream fails", async () => {
    const failTool: Tool = {
      name: "fail",
      description: "Always fails",
      parameters: { type: "object", properties: {} },
      async execute() {
        throw new Error("boom")
      },
    }

    const plan = makePlan({
      steps: [
        { name: "step-fail", stepType: "deterministic_tool", tool: "fail", args: {}, onError: "abort" },
        { name: "step-after", stepType: "deterministic_tool", tool: "fail", args: {}, dependsOn: ["step-fail"] },
      ],
      edges: [{ from: "step-fail", to: "step-after" }],
    })

    const result = await executePipeline(plan, [failTool], async () => ({ output: "" }))
    expect(result.status).toBe("failed")
    // step-after should be skipped because step-fail failed
    const afterResult = result.stepResults.get("step-after")
    expect(afterResult?.status).toBe("skipped")
  })

  it("delegates subagent_task steps to the delegateFn", async () => {
    const delegatedTasks: string[] = []

    const plan = makePlan({
      steps: [makeSubagentStep("build-game")],
      edges: [],
    })

    const result = await executePipeline(
      plan,
      [],
      async (step) => {
        delegatedTasks.push(step.name)
        return { output: "Build completed successfully" }
      },
    )

    expect(result.status).toBe("completed")
    expect(delegatedTasks).toContain("build-game")
  })

  it("respects abort signal", async () => {
    const controller = new AbortController()
    controller.abort()

    const plan = makePlan({
      steps: [
        { name: "step-1", stepType: "deterministic_tool", tool: "echo", args: { text: "a" } },
      ],
      edges: [],
    })

    const result = await executePipeline(plan, [echoTool()], async () => ({ output: "" }), {
      signal: controller.signal,
    })

    expect(result.status).toBe("failed")
  })

  it("reuses prior results (verified-pass steps not re-executed)", async () => {
    const calls: string[] = []
    const tool: Tool = {
      name: "echo",
      description: "Echo",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      async execute(args) {
        calls.push(String(args.text))
        return `done: ${String(args.text)}`
      },
    }

    const plan = makePlan({
      steps: [
        { name: "step-1", stepType: "deterministic_tool", tool: "echo", args: { text: "first" } },
        { name: "step-2", stepType: "deterministic_tool", tool: "echo", args: { text: "second" }, dependsOn: ["step-1"] },
      ],
      edges: [{ from: "step-1", to: "step-2" }],
    })

    const priorResults = new Map([
      ["step-1", { name: "step-1", status: "completed" as const, output: "done: first", durationMs: 10 }],
    ])

    const result = await executePipeline(plan, [tool], async () => ({ output: "" }), { priorResults })

    expect(result.status).toBe("completed")
    // step-1 should NOT be re-executed (it was in priorResults)
    expect(calls).toEqual(["second"])
  })
})

// ============================================================================
// Circuit breaker tests
// ============================================================================

describe("ToolFailureCircuitBreaker", () => {
  it("stays closed below threshold", () => {
    const cb = new ToolFailureCircuitBreaker({ threshold: 3, windowMs: 60_000 })

    cb.recordFailure("key1", "tool1")
    cb.recordFailure("key1", "tool1")

    expect(cb.getActiveCircuit()).toBeNull()
  })

  it("opens after reaching threshold", () => {
    const cb = new ToolFailureCircuitBreaker({ threshold: 3, windowMs: 60_000 })

    cb.recordFailure("key1", "tool1")
    cb.recordFailure("key1", "tool1")
    const reason = cb.recordFailure("key1", "tool1")

    expect(reason).toBeDefined()
    expect(reason).toContain("Circuit breaker opened")
    expect(cb.getActiveCircuit()).not.toBeNull()
  })

  it("tracks different keys independently", () => {
    const cb = new ToolFailureCircuitBreaker({ threshold: 3, windowMs: 60_000 })

    cb.recordFailure("key1", "tool1")
    cb.recordFailure("key1", "tool1")
    cb.recordFailure("key2", "tool2")
    cb.recordFailure("key2", "tool2")

    expect(cb.getActiveCircuit()).toBeNull()
  })

  it("clears pattern on success", () => {
    const cb = new ToolFailureCircuitBreaker({ threshold: 3, windowMs: 60_000 })

    cb.recordFailure("key1", "tool1")
    cb.recordFailure("key1", "tool1")
    cb.clearPattern("key1")
    cb.recordFailure("key1", "tool1")

    // Only 1 failure after clear, not 3
    expect(cb.getActiveCircuit()).toBeNull()
  })

  it("does nothing when disabled", () => {
    const cb = new ToolFailureCircuitBreaker({ enabled: false })

    cb.recordFailure("key1", "tool1")
    cb.recordFailure("key1", "tool1")
    cb.recordFailure("key1", "tool1")

    expect(cb.getActiveCircuit()).toBeNull()
  })
})

// ============================================================================
// Acceptance criteria keyword extraction
// ============================================================================

describe("extractCriterionKeywords", () => {
  it("extracts keyword stems from a castling criterion", () => {
    const kws = extractCriterionKeywords("castling must work correctly with rook and king")
    expect(kws.some(kw => "castling".includes(kw))).toBe(true)
  })

  it("extracts en passant multi-word phrase", () => {
    const kws = extractCriterionKeywords("en passant capture must be implemented")
    expect(kws).toContain("passant")
    expect(kws).toContain("enpassant")
  })

  it("extracts checkmate and stalemate", () => {
    const kws = extractCriterionKeywords("check and checkmate detection should end the game, stalemate should draw")
    expect(kws.some(kw => "checkmate".includes(kw))).toBe(true)
    expect(kws.some(kw => "stalemate".includes(kw))).toBe(true)
  })

  it("extracts pawn promotion keywords", () => {
    const kws = extractCriterionKeywords("pawn promotion to queen rook bishop or knight")
    expect(kws.some(kw => "promotion".includes(kw))).toBe(true)
    expect(kws.some(kw => "pawn".includes(kw))).toBe(true)
  })

  it("filters out stop words", () => {
    const kws = extractCriterionKeywords("must implement the code with this value")
    // All words are stop words → empty
    expect(kws.length).toBe(0)
  })

  it("handles non-game criteria (auth, API)", () => {
    const kws = extractCriterionKeywords("access control with role-based permissions")
    expect(kws).toContain("permission")
    expect(kws).toContain("authorize")
  })

  it("handles criteria with highlighting and selection", () => {
    const kws = extractCriterionKeywords("clicking a piece highlights its legal moves on the board")
    expect(kws.some(kw => "highlight".includes(kw))).toBe(true)
  })

  it("returns empty for very short generic criteria", () => {
    const kws = extractCriterionKeywords("it is ok")
    expect(kws.length).toBe(0)
  })
})
