/**
 * Planner subsystem tests — decision routing, plan validation,
 * pipeline execution, and circuit breaker behavior.
 */
import { describe, expect, it } from "vitest"
import { ToolFailureCircuitBreaker } from "../src/circuit-breaker.js"
import { assessPlannerDecision } from "../src/planner/decision.js"
import { isValidArtifactPath } from "../src/planner/generate.js"
import { synthesizeAnswer } from "../src/planner/index.js"
import { executePipeline, isGibberishIssue } from "../src/planner/pipeline.js"
import type { PipelineResult, Plan, SubagentTaskStep, VerifierDecision } from "../src/planner/types.js"
import { validatePlan } from "../src/planner/validate.js"
import { extractCriterionKeywords, isLLMGibberish, runDeterministicProbes } from "../src/planner/verifier.js"
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
    expect(result.valid).toBe(true) // warnings don't block
    expect(result.diagnostics.some(d => d.code === "vague_objective" && d.severity === "warning")).toBe(true)
  })

  it("detects missing acceptance criteria", () => {
    const plan = makePlan({
      steps: [makeSubagentStep("no-criteria", { acceptanceCriteria: [] })],
      edges: [],
    })

    const result = validatePlan(plan, [])
    expect(result.valid).toBe(true) // warnings don't block
    expect(result.diagnostics.some(d => d.code === "missing_acceptance_criteria" && d.severity === "warning")).toBe(true)
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
    expect(result.valid).toBe(true) // warnings don't block
    expect(result.diagnostics.some(d => d.code === "multiple_write_owners" && d.severity === "warning")).toBe(true)
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

  it("warns when HTML step doesn't mention script loading for JS artifacts", () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("create-html", {
          objective: "Create the HTML structure with an 8x8 grid",
          acceptanceCriteria: ["Board renders 8x8 grid with alternating colors"],
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/chess/index.html", "tmp/chess/styles.css"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
        makeSubagentStep("create-logic", {
          objective: "Implement game logic for the chess board",
          acceptanceCriteria: ["Move validation works for all pieces"],
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/chess/game.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
      ],
      edges: [],
    })

    const result = validatePlan(plan, [])
    expect(result.diagnostics.some(d => d.code === "html_missing_script_loading")).toBe(true)
  })

  it("passes when HTML step mentions script loading", () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("create-html", {
          objective: "Create the HTML structure with an 8x8 grid. Include <script src='game.js'> tag.",
          acceptanceCriteria: ["Board renders 8x8 grid", "HTML includes script tags for all JS files"],
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/chess/index.html"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
        makeSubagentStep("create-logic", {
          objective: "Implement game logic",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/chess/game.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
      ],
      edges: [],
    })

    const result = validatePlan(plan, [])
    expect(result.diagnostics.some(d => d.code === "html_missing_script_loading")).toBe(false)
  })

  it("warns when visual/game task has no visual rendering criteria", () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("render-board", {
          objective: "Create a chess board grid with HTML",
          acceptanceCriteria: ["Board has 8x8 grid", "Alternating colors on squares"],
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/chess/index.html"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
        makeSubagentStep("game-logic", {
          objective: "Implement chess game rules and move validation",
          acceptanceCriteria: ["Pawns can only move forward", "Castling works correctly"],
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/chess/game.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
      ],
      edges: [],
    })

    const result = validatePlan(plan, [])
    expect(result.diagnostics.some(d => d.code === "missing_visual_rendering_criteria")).toBe(true)
  })

  it("passes when visual task has rendering criteria", () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("render-board", {
          objective: "Create a chess board grid and render pieces",
          acceptanceCriteria: [
            "Board has 8x8 grid with alternating colors",
            "Pieces display correct Unicode symbols in starting positions",
          ],
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/chess/index.html"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
      ],
      edges: [],
    })

    const result = validatePlan(plan, [])
    expect(result.diagnostics.some(d => d.code === "missing_visual_rendering_criteria")).toBe(false)
  })

  it("warns when multi-file JS plan has no shared data contract", () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("create-board", {
          objective: "Create the chess board rendering with HTML and CSS grid",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/chess/board.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
        makeSubagentStep("create-logic", {
          objective: "Implement game logic with piece movement and board validation",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/chess/game.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
      ],
      edges: [],
    })

    const result = validatePlan(plan, [])
    expect(result.diagnostics.some(d => d.code === "missing_shared_data_contract")).toBe(true)
  })

  it("passes when JS steps define shared data format", () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("create-board", {
          objective: "Create the chess board. Each cell uses format { type: 'pawn', color: 'white' }. Board is board[row][col].",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/chess/board.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
        makeSubagentStep("create-logic", {
          objective: "Implement game logic with piece movement and board validation",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/chess/game.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
      ],
      edges: [],
    })

    const result = validatePlan(plan, [])
    expect(result.diagnostics.some(d => d.code === "missing_shared_data_contract")).toBe(false)
  })

  it("detects inconsistent top-level directories", () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("step-a", {
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
        makeSubagentStep("step-b", {
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/chess_game/js/board.js"],
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

  it("errors block pipeline but warnings don't", () => {
    // Plan with only warnings (vague objective) → valid: true
    const warningPlan = makePlan({
      steps: [makeSubagentStep("bad-step", { objective: "do it" })],
      edges: [],
    })
    const warningResult = validatePlan(warningPlan, [])
    expect(warningResult.valid).toBe(true)
    expect(warningResult.diagnostics.every(d => d.severity === "warning")).toBe(true)
    expect(warningResult.diagnostics.length).toBeGreaterThan(0)

    // Plan with error (unknown tool) → valid: false
    const errorPlan = makePlan({
      steps: [{
        name: "bad-tool",
        stepType: "deterministic_tool",
        tool: "nonexistent",
        args: {},
      }],
      edges: [],
    })
    const errorResult = validatePlan(errorPlan, [echoTool()])
    expect(errorResult.valid).toBe(false)
    expect(errorResult.diagnostics.some(d => d.severity === "error")).toBe(true)
  })

  it("cycle_detected is severity error", () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("a", { dependsOn: ["b"] }),
        makeSubagentStep("b", { dependsOn: ["a"] }),
      ],
      edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }],
    })
    const result = validatePlan(plan, [])
    expect(result.valid).toBe(false)
    expect(result.diagnostics.some(d => d.code === "cycle_detected" && d.severity === "error")).toBe(true)
  })
})

// ============================================================================
// Deterministic verifier probes (general modality coverage)
// ============================================================================

describe("Verifier: runDeterministicProbes modality coverage", () => {
  it("runs runtime verification for HTML artifacts even when verificationMode is none", async () => {
    let browserChecks = 0

    const plan = makePlan({
      steps: [
        makeSubagentStep("ui-step", {
          objective: "Build an interactive UI page",
          acceptanceCriteria: ["UI responds to clicks and updates state"],
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file", "read_file", "run_command", "browser_check"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/index.html", "tmp/app.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
      ],
      edges: [],
    })

    const pipelineResult: PipelineResult = {
      status: "completed",
      completedSteps: 1,
      totalSteps: 1,
      stepResults: new Map([
        ["ui-step", { name: "ui-step", status: "completed", output: "wrote tmp/index.html and tmp/app.js", durationMs: 1 }],
      ]),
    }

    const tools: Tool[] = [
      {
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        async execute(args) {
          const path = String(args.path)
          if (path.endsWith("index.html")) return "<html><body><script src='app.js'></script></body></html>"
          if (path.endsWith("app.js")) return "const state = { count: 0 }; function click() { state.count++; }"
          return ""
        },
      },
      {
        name: "run_command",
        description: "run",
        parameters: { type: "object", properties: { command: { type: "string" } } },
        async execute() {
          return "ok"
        },
      },
      {
        name: "browser_check",
        description: "browser",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        async execute() {
          browserChecks++
          return "No errors"
        },
      },
    ]

    const assessments = await runDeterministicProbes(plan, pipelineResult, tools)
    const step = assessments.find(a => a.stepName === "ui-step")
    expect(step).toBeDefined()
    expect(browserChecks).toBeGreaterThan(0)
    expect(step?.issues.some(i => i.includes("VERIFICATION MODALITY GAP"))).toBe(false)
  })

  it("reports runtime modality gap when runtime verification tools are unavailable", async () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("ui-step", {
          objective: "Create interactive dashboard behavior",
          acceptanceCriteria: ["User can click controls and navigate between views"],
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file", "read_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/index.html", "tmp/app.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
      ],
      edges: [],
    })

    const pipelineResult: PipelineResult = {
      status: "completed",
      completedSteps: 1,
      totalSteps: 1,
      stepResults: new Map([
        ["ui-step", { name: "ui-step", status: "completed", output: "wrote files", durationMs: 1 }],
      ]),
    }

    const tools: Tool[] = [
      {
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        async execute(args) {
          const path = String(args.path)
          if (path.endsWith("index.html")) return "<html><body><script src='app.js'></script></body></html>"
          if (path.endsWith("app.js")) return "function render(){ return true }"
          return ""
        },
      },
    ]

    const assessments = await runDeterministicProbes(plan, pipelineResult, tools)
    const step = assessments.find(a => a.stepName === "ui-step")
    expect(step).toBeDefined()
    expect(step?.issues.some(i => i.includes("VERIFICATION MODALITY GAP"))).toBe(true)
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

// ============================================================================
// synthesizeAnswer — honest status rendering
// ============================================================================

describe("synthesizeAnswer — verification status rendering", () => {
  const plan = makePlan({
    reason: "build chess game",
    steps: [makeSubagentStep("build_chess")],
  })

  function makePipelineResult(status: "completed" | "failed" = "completed"): PipelineResult {
    return {
      status: "completed",
      completedSteps: 1,
      totalSteps: 1,
      stepResults: new Map([
        ["build_chess", {
          name: "build_chess",
          status,
          output: "All files written successfully",
          durationMs: 5000,
        }],
      ]),
    }
  }

  it("marks step ✓ completed when verifier says pass", () => {
    const decision: VerifierDecision = {
      overall: "pass",
      confidence: 0.95,
      steps: [{ stepName: "build_chess", outcome: "pass", confidence: 0.95, issues: [], retryable: false }],
      unresolvedItems: [],
    }
    const answer = synthesizeAnswer(plan, makePipelineResult(), decision)
    expect(answer).toContain("All tasks completed and verified successfully")
    expect(answer).toContain("✓ build_chess")
    expect(answer).toContain("completed")
    expect(answer).not.toContain("incomplete")
  })

  it("marks step ⚠ incomplete when verifier says retry with issues", () => {
    const decision: VerifierDecision = {
      overall: "retry",
      confidence: 0.4,
      steps: [{
        stepName: "build_chess",
        outcome: "retry",
        confidence: 0.4,
        issues: ["Castling logic is a placeholder", "Missing checkmate detection"],
        retryable: true,
      }],
      unresolvedItems: ["Implement castling", "Implement checkmate"],
    }
    const answer = synthesizeAnswer(plan, makePipelineResult(), decision)
    expect(answer).toContain("Task verification FAILED")
    expect(answer).toContain("⚠ build_chess")
    expect(answer).toContain("incomplete")
    expect(answer).not.toContain("✓ build_chess")
    expect(answer).toContain("! Castling logic is a placeholder")
    expect(answer).toContain("! Missing checkmate detection")
  })

  it("marks step ⚠ incomplete on fail verdict too", () => {
    const decision: VerifierDecision = {
      overall: "fail",
      confidence: 0.2,
      steps: [{
        stepName: "build_chess",
        outcome: "fail",
        confidence: 0.2,
        issues: ["Child agent reported explicit failure"],
        retryable: false,
      }],
      unresolvedItems: [],
    }
    const answer = synthesizeAnswer(plan, makePipelineResult(), decision)
    expect(answer).toContain("Task FAILED")
    expect(answer).toContain("⚠ build_chess")
    expect(answer).toContain("incomplete")
  })

  it("renders unresolved items section", () => {
    const decision: VerifierDecision = {
      overall: "retry",
      confidence: 0.5,
      steps: [{
        stepName: "build_chess",
        outcome: "retry",
        confidence: 0.5,
        issues: ["Missing en passant"],
        retryable: true,
      }],
      unresolvedItems: ["Implement en passant rule"],
    }
    const answer = synthesizeAnswer(plan, makePipelineResult(), decision)
    expect(answer).toContain("Unresolved:")
    expect(answer).toContain("Implement en passant rule")
  })

  it("keeps ✓ for passing steps even when overall is retry (multi-step)", () => {
    const multiPlan = makePlan({
      reason: "build chess game",
      steps: [
        makeSubagentStep("setup_board"),
        makeSubagentStep("add_rules", { objective: "Add game rules" }),
      ],
    })
    const pipelineResult: PipelineResult = {
      status: "completed",
      completedSteps: 2,
      totalSteps: 2,
      stepResults: new Map([
        ["setup_board", { name: "setup_board", status: "completed", output: "Board done", durationMs: 3000 }],
        ["add_rules", { name: "add_rules", status: "completed", output: "Rules done", durationMs: 4000 }],
      ]),
    }
    const decision: VerifierDecision = {
      overall: "retry",
      confidence: 0.6,
      steps: [
        { stepName: "setup_board", outcome: "pass", confidence: 0.9, issues: [], retryable: false },
        { stepName: "add_rules", outcome: "retry", confidence: 0.4, issues: ["Missing castling"], retryable: true },
      ],
      unresolvedItems: [],
    }
    const answer = synthesizeAnswer(multiPlan, pipelineResult, decision)
    expect(answer).toContain("✓ setup_board")
    expect(answer).toContain("⚠ add_rules")
    expect(answer).toContain("incomplete")
  })
})

// ============================================================================
// Gibberish issue detection
// ============================================================================

describe("Gibberish issue detection", () => {
  describe("isGibberishIssue (pipeline)", () => {
    it("detects compound-hyphenated word-salad", () => {
      expect(isGibberishIssue(
        "Edge-action resets fail appropriate bound-scoping interpolated mouse-rerun initialization layers creating block-scenario loop-redundancies",
      )).toBe(true)
    })

    it("detects gibberish with very few function words", () => {
      expect(isGibberishIssue(
        "clearHighlights fail appropriate bound-scoping interpolated mouse-rerun initialization layers creating block scenario loop redundancies unresolved coordination assured surround unpredictable",
      )).toBe(true)
    })

    it("passes through legitimate issues with file paths", () => {
      expect(isGibberishIssue(
        "game_logic.js: getLegalMoves returns empty array for all piece types — stub detected",
      )).toBe(false)
    })

    it("passes through short issues", () => {
      expect(isGibberishIssue("Missing castling logic")).toBe(false)
    })

    it("passes through issues mentioning code patterns", () => {
      expect(isGibberishIssue(
        "The function isValidMove in game_logic.js contains a placeholder `return true` instead of real validation logic for each piece type",
      )).toBe(false)
    })
  })

  describe("isLLMGibberish (verifier)", () => {
    it("detects pure word-salad from degenerated LLM", () => {
      expect(isLLMGibberish(
        "frame-hydro-exclusive memory-chaining cleanup fails interactive clearance fails qualifiers mis-nullify-control-actionations errors overall preservation misses automated-recursive",
      )).toBe(true)
    })

    it("keeps valid technical issues", () => {
      expect(isLLMGibberish(
        "The render_chessboard step creates board.js but does not implement the drawPieces function — it returns immediately without rendering any pieces on the board",
      )).toBe(false)
    })

    it("keeps issues with stub/placeholder keywords", () => {
      expect(isLLMGibberish(
        "stub: isInCheck returns false always without checking if the king is attacked by any opponent piece",
      )).toBe(false)
    })
  })
})

// ============================================================================
// Artifact path validation
// ============================================================================

describe("isValidArtifactPath", () => {
  it("accepts normal file paths", () => {
    expect(isValidArtifactPath("game.js")).toBe(true)
    expect(isValidArtifactPath("tmp/chess/index.html")).toBe(true)
    expect(isValidArtifactPath("src/board_logic.js")).toBe(true)
    expect(isValidArtifactPath("styles.css")).toBe(true)
  })

  it("rejects CSS selectors", () => {
    expect(isValidArtifactPath(".square.light")).toBe(false)
    expect(isValidArtifactPath(".square.dark")).toBe(false)
    expect(isValidArtifactPath("#chessboard")).toBe(false)
    expect(isValidArtifactPath(".game-container")).toBe(false)
  })

  it("accepts dotfile paths with directories", () => {
    // .hidden/config.json is a valid path even though it starts with .
    expect(isValidArtifactPath(".hidden/config.json")).toBe(true)
  })

  it("rejects bare words without extension or path separator", () => {
    expect(isValidArtifactPath("chessboard")).toBe(false)
    expect(isValidArtifactPath("game_logic")).toBe(false)
  })
})
