/**
 * Planner subsystem tests — decision routing, plan validation,
 * pipeline execution, and circuit breaker behavior.
 */
import { describe, expect, it, vi } from "vitest"
import { ToolFailureCircuitBreaker } from "../src/circuit-breaker.js"
import * as delegationDecision from "../src/delegation-decision.js"
import { parseBlueprintContractBlock } from "../src/planner/blueprint-contract.js"
import { assessPlannerDecision } from "../src/planner/decision.js"
import { generatePlan, isValidArtifactPath } from "../src/planner/generate.js"
import { executePlannerPath, inferForcedOutputDirectoryFromGoal, synthesizeAnswer } from "../src/planner/index.js"
import { executePipeline, isGibberishIssue } from "../src/planner/pipeline.js"
import type { PipelineResult, Plan, SubagentTaskStep, VerifierDecision } from "../src/planner/types.js"
import { validatePlan } from "../src/planner/validate.js"
import { isLLMGibberish, runDeterministicProbes } from "../src/planner/verifier.js"
import { CHILD_SYSTEM_PROMPT } from "../src/tools/delegate.js"
import type { LLMClient, Tool } from "../src/types.js"

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

function makeBlueprintContract(paths: readonly string[]): string {
  return [
    "```blueprint-contract",
    JSON.stringify({
      version: 1,
      files: paths.map(path => ({ path, purpose: `Purpose for ${path}`, functions: [] })),
      sharedTypes: [],
    }, null, 2),
    "```",
  ].join("\n")
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

  it("keeps explicit single-file full implementation in direct burst path", () => {
    const decision = assessPlannerDecision(
      "Implement the full auth flow in single file src/auth.ts with complete logic from scratch",
      [],
    )
    expect(decision.shouldPlan).toBe(false)
    expect(decision.reason).toBe("single_artifact_direct_burst")
  })

  it("does NOT use direct burst when no concrete target file is provided", () => {
    const decision = assessPlannerDecision(
      "Implement a full auth flow in a single file with complete logic from scratch",
      [],
    )
    expect(decision.shouldPlan).toBe(true)
  })

  it("does NOT use direct burst for ambiguous multi-target requests", () => {
    const decision = assessPlannerDecision(
      "Implement a full auth flow in single file src/auth.ts and add backend service wiring",
      [],
    )
    expect(decision.shouldPlan).toBe(true)
  })

  it("keeps trace-like multi-artifact game goals in planner path", () => {
    const decision = assessPlannerDecision(
      "Build a complete playable chess game and create tmp/game/index.html, tmp/game/styles.css, and tmp/game/game.js with verification.",
      [],
    )
    expect(decision.shouldPlan).toBe(true)
    expect(decision.reason).toContain("implementation_scope")
  })
})

describe("Planner output-root inference", () => {
  it("forces tmp root when goal declares temporary working directory named tmp", () => {
    const goal = "Create a temporary working directory named tmp where all project files will be stored and organized."
    expect(inferForcedOutputDirectoryFromGoal(goal)).toBe("tmp")
  })

  it("extracts explicit output root from all-project-files constraint", () => {
    const goal = "Build the app and keep all project files inside sandbox/workdir for this task."
    expect(inferForcedOutputDirectoryFromGoal(goal)).toBe("sandbox/workdir")
  })

  it("returns null when goal does not specify a strict output directory", () => {
    const goal = "Implement a dashboard with tests and API integration."
    expect(inferForcedOutputDirectoryFromGoal(goal)).toBeNull()
  })
})

describe("Blueprint contract parsing", () => {
  it("accepts shorthand string arrays for functions and shared types", () => {
    const parsed = parseBlueprintContractBlock([
      "```blueprint-contract",
      JSON.stringify({
        version: 1,
        files: [
          {
            path: "tmp/game_logic.js",
            purpose: "Game rules",
            functions: ["initializeGame", "validateMove"],
          },
          {
            path: "tmp/index.html",
            purpose: "UI shell",
            functions: [],
          },
        ],
        sharedTypes: ["Piece", "GameState"],
      }, null, 2),
      "```",
    ].join("\n"))

    expect(parsed.present).toBe(true)
    expect(parsed.errors).toEqual([])
    expect(parsed.files[0]?.functions.map(fn => fn.name)).toEqual(["initializeGame", "validateMove"])
    expect(parsed.sharedTypes.map(type => type.name)).toEqual(["Piece", "GameState"])
  })
})

describe("Planner path execution", () => {
  it("tells the planner to choose the best language for the goal and scopes ESM rules to browser JS/TS", async () => {
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        reason: "python fits best",
        confidence: 0.8,
        requiresSynthesis: false,
        steps: [
          {
            name: "write_script",
            stepType: "subagent_task",
            dependsOn: [],
            objective: "Create tmp/process.py",
            inputContract: "Empty workspace",
            acceptanceCriteria: ["Script processes the target input and writes the requested output"],
            requiredToolCapabilities: ["write_file", "read_file"],
            contextRequirements: [],
            executionContext: {
              workspaceRoot: ".",
              allowedReadRoots: ["."],
              allowedWriteRoots: ["."],
              allowedTools: ["write_file", "read_file"],
              requiredSourceArtifacts: [],
              targetArtifacts: ["tmp/process.py"],
              effectClass: "filesystem_write",
              verificationMode: "none",
              artifactRelations: [],
            },
            maxBudgetHint: "20 iterations",
            canRunParallel: false,
          },
        ],
        edges: [],
      }),
      toolCalls: [],
    })

    const llm: LLMClient = { chat }

    await generatePlan(llm, {
      goal: "Process a CSV and emit a summary report; use Python if that is the best fit.",
      workspaceRoot: ".",
      availableTools: [echoTool("write_file"), echoTool("read_file")],
      history: [],
    })

    const messages = chat.mock.calls[0]?.[0] as Array<{ role: string; content: string }>
    const systemPrompt = messages?.find(message => message.role === "system" && message.content.includes("## Rules"))?.content ?? ""

    expect(systemPrompt).toContain("CHOOSE THE BEST IMPLEMENTATION MEDIUM FOR THE GOAL")
    expect(systemPrompt).toContain("Do NOT default to JavaScript for every task")
    expect(systemPrompt).toContain("This rule applies ONLY when the plan includes browser-loaded JS/TS runtime code referenced by HTML")
    expect(systemPrompt).toContain("This rule does NOT mean Python, shell, awk/sed, PowerShell, or other non-browser implementation options are disallowed")
    expect(systemPrompt).toContain("HELPER/CALL DEPENDENCY CLOSURE MUST BE EXPLICIT")
    expect(systemPrompt).toContain("Do NOT leave dangling references like calling helper functions that are never defined anywhere")
    expect(systemPrompt).toContain("VISUAL STATE/STYLING CONTRACT MUST BE EXPLICIT")
    expect(systemPrompt).toContain("row/column parity or equivalent coordinate-aware logic")
  })

  it("gives child workers an explicit no-dangling-helper contract and consistent browser module guidance", () => {
    expect(CHILD_SYSTEM_PROMPT).toContain("DEPENDENCY CLOSURE RULE")
    expect(CHILD_SYSTEM_PROMPT).toContain("must be defined in that same file or imported")
    expect(CHILD_SYSTEM_PROMPT).toContain("VISUAL WIRING RULE")
    expect(CHILD_SYSTEM_PROMPT).toContain("row/column parity")
    expect(CHILD_SYSTEM_PROMPT).toContain("use ES modules consistently")
    expect(CHILD_SYSTEM_PROMPT).not.toContain("put ALL code in plain `<script>` tags")
  })

  it("auto-remediates dependent shared target ownership before execution", async () => {
    const llm: LLMClient = {
      chat: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          reason: "split html and interaction work",
          confidence: 0.92,
          requiresSynthesis: false,
          steps: [
            {
              name: "implement_board_rendering",
              stepType: "subagent_task",
              objective: "Create tmp/index.html with the board markup and full static structure",
              inputContract: "Empty workspace",
              acceptanceCriteria: ["Board renders", "HTML structure is complete"],
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
                targetArtifacts: ["tmp/index.html"],
                effectClass: "filesystem_write",
                verificationMode: "none",
                artifactRelations: [{ relationType: "write_owner", artifactPath: "tmp/index.html" }],
              },
            },
            {
              name: "integrate_ui_interactions",
              stepType: "subagent_task",
              objective: "Update tmp/index.html with interaction hooks and final UI behavior",
              inputContract: "Board markup exists",
              acceptanceCriteria: ["Interactions work", "HTML wiring is complete"],
              requiredToolCapabilities: ["write_file", "read_file"],
              contextRequirements: ["needs previous output"],
              maxBudgetHint: "10 iterations",
              canRunParallel: false,
              executionContext: {
                workspaceRoot: ".",
                allowedReadRoots: ["."],
                allowedWriteRoots: ["."],
                allowedTools: ["write_file", "read_file"],
                requiredSourceArtifacts: ["tmp/index.html"],
                targetArtifacts: ["tmp/index.html"],
                effectClass: "filesystem_write",
                verificationMode: "none",
                artifactRelations: [{ relationType: "write_owner", artifactPath: "tmp/index.html" }],
              },
            },
          ],
          edges: [{ from: "implement_board_rendering", to: "integrate_ui_interactions" }],
        }),
        toolCalls: [],
      }),
    }

    const traces: Array<Record<string, unknown>> = []
    const result = await executePlannerPath(
      "Build a complete playable chess game in tmp with multiple coordinated files and interactions.",
      {
        llm,
        tools: [echoTool("write_file"), echoTool("read_file")],
        workspaceRoot: ".",
        history: [],
        onTrace: (entry) => traces.push(entry),
      },
      async () => ({ output: "unused" }),
    )

    expect(result.handled).toBe(true)
    expect(result.answer).not.toContain('"stage": "validation"')
    expect(result.plan).toBeDefined()
    const htmlOwners = result.plan?.steps
      .filter((step): step is SubagentTaskStep => step.stepType === "subagent_task")
      .filter((step) => step.executionContext.targetArtifacts.includes("tmp/index.html"))
    expect(htmlOwners).toHaveLength(1)
    expect(htmlOwners?.[0]?.executionContext.verificationMode).not.toBe("browser_check")
    expect(traces.some((entry) => entry.kind === "planner-validation-remediated")).toBe(true)
    expect(traces.some((entry) => entry.kind === "planner-fallback-direct-loop")).toBe(false)
  })

  it("halts on unrepaired validation failures instead of falling back to the direct loop", async () => {
    const llm: LLMClient = {
      chat: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          reason: "two unrelated writers collide on the same html file",
          confidence: 0.92,
          requiresSynthesis: false,
          steps: [
            {
              name: "implement_static_files",
              stepType: "subagent_task",
              objective: "Create tmp/index.html and CSS shell",
              inputContract: "Empty workspace",
              acceptanceCriteria: ["Static files exist"],
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
                targetArtifacts: ["tmp/index.html"],
                effectClass: "filesystem_write",
                verificationMode: "none",
                artifactRelations: [{ relationType: "write_owner", artifactPath: "tmp/index.html" }],
              },
            },
            {
              name: "rewrite_index_for_overlay",
              stepType: "subagent_task",
              objective: "Rewrite tmp/index.html for a different overlay experiment",
              inputContract: "Independent overlay requirements",
              acceptanceCriteria: ["Overlay markup exists"],
              requiredToolCapabilities: ["write_file", "read_file"],
              contextRequirements: [],
              maxBudgetHint: "10 iterations",
              canRunParallel: true,
              executionContext: {
                workspaceRoot: ".",
                allowedReadRoots: ["."],
                allowedWriteRoots: ["."],
                allowedTools: ["write_file", "read_file"],
                requiredSourceArtifacts: [],
                targetArtifacts: ["tmp/index.html"],
                effectClass: "filesystem_write",
                verificationMode: "none",
                artifactRelations: [{ relationType: "write_owner", artifactPath: "tmp/index.html" }],
              },
            },
          ],
          edges: [],
        }),
        toolCalls: [],
      }),
    }

    const traces: Array<Record<string, unknown>> = []
    const result = await executePlannerPath(
      "Build a complete playable chess game in tmp with multiple coordinated files and interactions.",
      {
        llm,
        tools: [echoTool("write_file"), echoTool("read_file")],
        workspaceRoot: ".",
        history: [],
        onTrace: (entry) => traces.push(entry),
      },
      async () => ({ output: "unused" }),
    )

    expect(result.handled).toBe(true)
    expect(result.answer).toContain('"stage": "validation"')
    expect(result.answer).toContain("shared_target_artifact")
    expect(result.plan).toBeDefined()
    expect(traces.some((entry) => entry.kind === "planner-validation-failed")).toBe(true)
    expect(traces.some((entry) => entry.kind === "planner-fallback-direct-loop")).toBe(false)
  })

  it("aborts before the first implementation child when the generated blueprint contract is broken", async () => {
    const delegationSpy = vi.spyOn(delegationDecision, "assessDelegationDecision").mockReturnValue({
      shouldDelegate: true,
      reason: "approved",
      threshold: 0.2,
      utilityScore: 0.8,
      decompositionBenefit: 0.8,
      coordinationOverhead: 0.2,
      latencyCostRisk: 0.2,
      safetyRisk: 0.1,
      confidence: 0.9,
      hardBlockedTaskClass: null,
      hardBlockedTaskClassSource: null,
      hardBlockedTaskClassSignal: null,
      diagnostics: {},
    })
    const llm: LLMClient = {
      chat: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          reason: "write blueprint before implementation",
          confidence: 0.95,
          requiresSynthesis: false,
          steps: [
            {
              name: "generate_blueprint",
              stepType: "subagent_task",
              objective: "Create tmp/BLUEPRINT.md that specifies tmp/game_logic.js exactly",
              inputContract: "Empty workspace",
              acceptanceCriteria: ["Blueprint contract exactly matches the planned artifact list"],
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
                targetArtifacts: ["tmp/BLUEPRINT.md"],
                effectClass: "filesystem_write",
                verificationMode: "none",
                artifactRelations: [{ relationType: "write_owner", artifactPath: "tmp/BLUEPRINT.md" }],
              },
            },
            {
              name: "implement_logic",
              stepType: "subagent_task",
              objective: "Create tmp/game_logic.js with full rules logic",
              inputContract: "Blueprint exists",
              acceptanceCriteria: ["Rules are implemented"],
              requiredToolCapabilities: ["write_file", "read_file"],
              contextRequirements: ["follow blueprint"],
              maxBudgetHint: "20 iterations",
              canRunParallel: false,
              executionContext: {
                workspaceRoot: ".",
                allowedReadRoots: ["."],
                allowedWriteRoots: ["."],
                allowedTools: ["write_file", "read_file"],
                requiredSourceArtifacts: ["tmp/BLUEPRINT.md"],
                targetArtifacts: ["tmp/game_logic.js"],
                effectClass: "filesystem_write",
                verificationMode: "none",
                artifactRelations: [{ relationType: "write_owner", artifactPath: "tmp/game_logic.js" }],
              },
            },
          ],
          edges: [{ from: "generate_blueprint", to: "implement_logic" }],
        }),
        toolCalls: [],
      }),
    }

    const delegatedSteps: string[] = []
    try {
      const result = await executePlannerPath(
        "Build a multi-file game in tmp with coordinated rules and UI.",
        {
          llm,
          tools: [
            echoTool("write_file"),
            echoTool("think"),
            {
              name: "read_file",
              description: "read",
              parameters: { type: "object", properties: { path: { type: "string" } } },
              async execute(args) {
                const path = String(args.path)
                if (path.endsWith("BLUEPRINT.md")) {
                  return [
                    "# Broken Blueprint",
                    "",
                    makeBlueprintContract(["game/index.html", "game/rules.js"]),
                  ].join("\n")
                }
                return "Error: not found"
              },
            },
          ],
          workspaceRoot: ".",
          history: [],
        },
        async (step) => {
          delegatedSteps.push(step.name)
          return {
            output: `done ${step.name}`,
            toolCalls: [
              { name: "write_file", args: { path: step.executionContext.targetArtifacts[0] ?? "tmp/BLUEPRINT.md", content: "ok" }, result: "ok", isError: false },
              { name: "read_file", args: { path: "tmp/BLUEPRINT.md" }, result: "ok", isError: false },
            ],
          }
        },
      )

      expect(delegatedSteps.length).toBeGreaterThan(0)
      expect(delegatedSteps.every((name) => name === "generate_blueprint")).toBe(true)
      expect(result.handled).toBe(true)
      expect(result.pipelineResult?.stepResults.get("generate_blueprint")?.failureClass).toBe("blueprint_contract")
      expect(result.pipelineResult?.stepResults.get("implement_logic")?.status).toBe("skipped")
    } finally {
      delegationSpy.mockRestore()
    }
  })

  it("seeds injected blueprint steps with an exact template and read-back repair instructions", async () => {
    const delegationSpy = vi.spyOn(delegationDecision, "assessDelegationDecision").mockReturnValue({
      shouldDelegate: true,
      reason: "approved",
      threshold: 0.2,
      utilityScore: 0.8,
      decompositionBenefit: 0.8,
      coordinationOverhead: 0.2,
      latencyCostRisk: 0.2,
      safetyRisk: 0.1,
      confidence: 0.9,
      hardBlockedTaskClass: null,
      hardBlockedTaskClassSource: null,
      hardBlockedTaskClassSignal: null,
      diagnostics: {},
    })
    const llm: LLMClient = {
      chat: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          reason: "multi-file implementation",
          confidence: 0.9,
          requiresSynthesis: false,
          steps: [
            {
              name: "build_markup",
              stepType: "subagent_task",
              objective: "Create tmp/index.html",
              inputContract: "Empty workspace",
              acceptanceCriteria: ["HTML exists"],
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
                targetArtifacts: ["tmp/index.html"],
                effectClass: "filesystem_write",
                verificationMode: "none",
                artifactRelations: [],
              },
            },
            {
              name: "build_logic",
              stepType: "subagent_task",
              objective: "Create tmp/game_logic.js",
              inputContract: "Empty workspace",
              acceptanceCriteria: ["Logic exists"],
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
                targetArtifacts: ["tmp/game_logic.js"],
                effectClass: "filesystem_write",
                verificationMode: "none",
                artifactRelations: [],
              },
            },
          ],
          edges: [{ from: "build_markup", to: "build_logic" }],
        }),
        toolCalls: [],
      }),
    }

    let capturedBlueprintObjective = ""
    try {
      await executePlannerPath(
        "Build a tmp web app with markup and logic.",
        {
          llm,
          tools: [echoTool("write_file"), echoTool("read_file"), echoTool("think")],
          workspaceRoot: ".",
          history: [],
        },
        async (step) => {
          if (step.name === "generate_blueprint") {
            capturedBlueprintObjective = step.objective
          }
          return {
            output: `done ${step.name}`,
            toolCalls: [
              { name: "write_file", args: { path: step.executionContext.targetArtifacts[0] ?? "tmp/BLUEPRINT.md", content: "ok" }, result: "ok", isError: false },
              { name: "read_file", args: { path: step.executionContext.targetArtifacts[0] ?? "tmp/BLUEPRINT.md" }, result: makeBlueprintContract(["tmp/index.html", "tmp/game_logic.js"]), isError: false },
            ],
          }
        },
      )
    } finally {
      delegationSpy.mockRestore()
    }

    expect(capturedBlueprintObjective).toContain("MANDATORY TEMPLATE")
    expect(capturedBlueprintObjective).toContain("```blueprint-contract")
    expect(capturedBlueprintObjective).toContain("tmp/index.html")
    expect(capturedBlueprintObjective).toContain("tmp/game_logic.js")
    expect(capturedBlueprintObjective).toContain("Immediately read \"tmp/BLUEPRINT.md\" back with read_file")
  })

  it("injects browser runtime wiring and module-boundary contracts into HTML and JS steps", async () => {
    const delegationSpy = vi.spyOn(delegationDecision, "assessDelegationDecision")
    delegationSpy.mockReturnValue({
      shouldDelegate: true,
      reason: "approved",
      utilityScore: 0.9,
      decompositionBenefit: 0.8,
      coordinationOverhead: 0.2,
      latencyCostRisk: 0.2,
      safetyRisk: 0.1,
      threshold: 0.2,
      confidence: 0.9,
      hardBlockedTaskClass: null,
      hardBlockedTaskClassSource: null,
      hardBlockedTaskClassSignal: null,
      diagnostics: {},
    })
    const llm: LLMClient = {
      chat: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          reason: "browser app",
          confidence: 0.9,
          requiresSynthesis: false,
          steps: [
            {
              name: "build_browser_app",
              stepType: "subagent_task",
              objective: "Create tmp/index.html and tmp/game_logic.js",
              inputContract: "Empty workspace",
              acceptanceCriteria: ["HTML exists", "Logic exists"],
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
                targetArtifacts: ["tmp/index.html", "tmp/game_logic.js"],
                effectClass: "filesystem_write",
                verificationMode: "none",
                artifactRelations: [],
              },
            },
          ],
          edges: [],
        }),
        toolCalls: [],
      }),
    }

    let capturedMarkupObjective = ""
    let capturedLogicObjective = ""
    let capturedMarkupCriteria: readonly string[] = []
    let capturedLogicCriteria: readonly string[] = []

    try {
      await executePlannerPath(
        "Build a tmp browser app with index.html and game logic.",
        {
          llm,
          tools: [echoTool("write_file"), echoTool("read_file"), echoTool("think")],
          workspaceRoot: ".",
          history: [],
        },
        async (step) => {
          if (step.executionContext.targetArtifacts.includes("tmp/index.html")) {
            capturedMarkupObjective = step.objective
            capturedMarkupCriteria = [...step.acceptanceCriteria]
          }
          if (step.executionContext.targetArtifacts.includes("tmp/game_logic.js")) {
            capturedLogicObjective = step.objective
            capturedLogicCriteria = [...step.acceptanceCriteria]
          }
          const primaryArtifact = step.executionContext.targetArtifacts[0] ?? "tmp/BLUEPRINT.md"
          return {
            output: `done ${step.name}`,
            toolCalls: [
              { name: "write_file", args: { path: primaryArtifact, content: "ok" }, result: "ok", isError: false },
              { name: "read_file", args: { path: primaryArtifact }, result: `content for ${primaryArtifact}`, isError: false },
            ],
          }
        },
      )
    } finally {
      delegationSpy.mockRestore()
    }

    expect(capturedMarkupObjective).toContain("Entrypoint wiring contract")
    expect(capturedMarkupCriteria.some((criterion) => criterion.includes("game_logic.js"))).toBe(true)
    expect(capturedLogicObjective).toContain("runtime JS must use ES modules consistently")
    expect(capturedLogicCriteria).toContain("Uses ES modules consistently in browser runtime files; cross-file dependencies use import/export and no CommonJS or window globals.")
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
    expect(result.valid).toBe(false)
    expect(result.diagnostics.some(d => d.code === "multiple_write_owners" && d.severity === "error")).toBe(true)
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
    expect(result.valid).toBe(false)
    expect(result.diagnostics.some(d => d.code === "inconsistent_output_directory" && d.severity === "error")).toBe(true)
  })

  it("allows sibling subdirectories under a single root output tree", () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("step-css", {
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/css/styles.css"],
            effectClass: "filesystem_write",
            verificationMode: "browser_check",
            artifactRelations: [],
          },
        }),
        makeSubagentStep("step-js", {
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/js/game.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
      ],
      edges: [],
    })

    const result = validatePlan(plan, [])
    expect(result.diagnostics.some(d => d.code === "inconsistent_output_directory")).toBe(false)
  })

  it("treats missing per-step verification coverage as non-blocking guidance", () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("writer-a", {
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/a.txt"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
        makeSubagentStep("writer-b", {
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/b.txt"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
      ],
      edges: [],
    })

    const result = validatePlan(plan, [])
    expect(result.valid).toBe(true)
    expect(result.diagnostics.some(d => d.code === "no_verification_steps" && d.severity === "warning")).toBe(true)
  })

  it("does not warn for HTML scaffold steps that do not own JS artifacts", () => {
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
    expect(result.diagnostics.some(d => d.code === "missing_dependency_wiring_criteria")).toBe(false)
  })

  it("warns when a consumer step owns dependency artifacts but doesn't mention wiring", () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("create-html-and-js", {
          objective: "Create the HTML structure and initialize game logic",
          acceptanceCriteria: ["Board renders 8x8 grid"],
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/app/index.html", "tmp/app/game.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
      ],
      edges: [],
    })

    const result = validatePlan(plan, [])
    expect(result.diagnostics.some(d => d.code === "missing_dependency_wiring_criteria")).toBe(true)
  })

  it("passes when a consumer step owns dependency artifacts and mentions wiring", () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("create-html-and-js", {
          objective: "Create the HTML structure with an 8x8 grid. Include <script src='game.js'> tag.",
          acceptanceCriteria: ["Board renders 8x8 grid", "HTML includes script tags for all JS files"],
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/app/index.html", "tmp/app/game.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
      ],
      edges: [],
    })

    const result = validatePlan(plan, [])
    expect(result.diagnostics.some(d => d.code === "missing_dependency_wiring_criteria")).toBe(false)
  })

  it("blocks browser_check when related JS files are owned by other steps", () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("create-html", {
          objective: "Create index.html and verify in browser",
          acceptanceCriteria: ["HTML renders", "No runtime errors"],
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file", "browser_check"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/index.html", "tmp/styles.css"],
            effectClass: "filesystem_write",
            verificationMode: "browser_check",
            artifactRelations: [],
          },
        }),
        makeSubagentStep("create-logic", {
          objective: "Create board/game/ui scripts",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/board.js", "tmp/game.js", "tmp/ui.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
      ],
      edges: [],
    })

    const result = validatePlan(plan, [])
    expect(result.valid).toBe(false)
    expect(result.diagnostics.some(d => d.code === "premature_browser_verification" && d.severity === "error")).toBe(true)
  })

  it("allows browser_check when HTML step owns related JS files", () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("create-html-and-js", {
          objective: "Create HTML and related scripts, then verify in browser",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file", "browser_check"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/index.html", "tmp/styles.css", "tmp/board.js", "tmp/game.js", "tmp/ui.js"],
            effectClass: "filesystem_write",
            verificationMode: "browser_check",
            artifactRelations: [],
          },
        }),
        makeSubagentStep("other-page-script", {
          objective: "Create admin page script",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/admin/monitor.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
      ],
      edges: [],
    })

    const result = validatePlan(plan, [])
    expect(result.diagnostics.some(d => d.code === "premature_browser_verification")).toBe(false)
  })

  it("warns when visual task has no visual rendering criteria", () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("render-layout", {
          objective: "Create a visual dashboard grid with HTML",
          acceptanceCriteria: ["Layout has a 3x3 grid", "Alternating colors on sections"],
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/app/index.html"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
        makeSubagentStep("game-logic", {
          objective: "Implement domain rules and action validation",
          acceptanceCriteria: ["Invalid actions are rejected", "State transitions are validated"],
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/app/logic.js"],
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
        makeSubagentStep("render-ui", {
          objective: "Create a dashboard layout and render widgets",
          acceptanceCriteria: [
            "Layout has distinct visual regions with clear styling",
            "Widgets render visible labels and status indicators",
          ],
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/app/index.html"],
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
        makeSubagentStep("create-state-view", {
          objective: "Create state rendering with HTML and CSS grid",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/app/state-view.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
        makeSubagentStep("create-logic", {
          objective: "Implement domain logic with validation and state updates",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/app/logic.js"],
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
        makeSubagentStep("create-state-view", {
          objective: "Create the shared model. Records use format { id: string, status: string }. State is a keyed map by id.",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/app/state-view.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
        makeSubagentStep("create-logic", {
          objective: "Implement domain logic with validation and state updates",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/app/logic.js"],
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
    expect(step?.issues.some(i => i.includes("CRITERIA PROOF MISSING"))).toBe(true)
    expect(step?.outcome).toBe("fail")
    expect(step?.retryable).toBe(true)
  })

  it("fails when shared-state contract consumer does not declare owner artifact as required source", async () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("rules-step", {
          objective: "Implement rules against shared state",
          acceptanceCriteria: ["Legal moves are validated against shared state"],
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file", "read_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/rules.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
            sharedStateContract: {
              contractId: "shared-state:tmp/state.js",
              ownerStepName: "state-step",
              ownerArtifactPath: "tmp/state.js",
              schema: "single shared state object",
              mutationPolicy: "owner-only",
            },
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
        ["rules-step", { name: "rules-step", status: "completed", output: "updated tmp/rules.js", durationMs: 1 }],
      ]),
    }

    const tools: Tool[] = [
      {
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        async execute(args) {
          if (String(args.path).endsWith("rules.js")) {
            return "function validateMove(state, move) { return !!state && !!move }"
          }
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
    ]

    const assessments = await runDeterministicProbes(plan, pipelineResult, tools)
    const step = assessments.find(a => a.stepName === "rules-step")
    expect(step).toBeDefined()
    expect(step?.issues.some(i => i.includes("shared-state contract"))).toBe(true)
    expect(step?.outcome).toBe("fail")
    expect(step?.retryable).toBe(false)
  })

  it("defers cross-step HTML/JS integration checks until all subagent steps are complete", async () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("create-html", {
          objective: "Create HTML shell",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file", "read_file", "browser_check"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/app/index.html"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
        makeSubagentStep("create-js", {
          objective: "Create JS logic",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file", "read_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/app/game-logic.js", "tmp/app/ui-logic.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
      ],
      edges: [{ from: "create-html", to: "create-js" }],
    })

    const pipelineResult: PipelineResult = {
      status: "failed",
      completedSteps: 1,
      totalSteps: 2,
      stepResults: new Map([
        ["create-html", { name: "create-html", status: "completed", output: "wrote tmp/app/index.html", durationMs: 1 }],
        ["create-js", { name: "create-js", status: "skipped", error: "upstream aborted", durationMs: 0 }],
      ]),
    }

    const tools: Tool[] = [
      {
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        async execute(args) {
          const path = String(args.path)
          if (path.endsWith("index.html")) return "<html><body><h1>Chess</h1></body></html>"
          if (path.endsWith("game-logic.js")) return "export const game = {}"
          if (path.endsWith("ui-logic.js")) return "export const ui = {}"
          return "Error: not found"
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
          return "No errors"
        },
      },
    ]

    const assessments = await runDeterministicProbes(plan, pipelineResult, tools)
    const htmlStep = assessments.find(a => a.stepName === "create-html")
    expect(htmlStep).toBeDefined()
    expect(htmlStep?.issues.some(i => i.includes("Integration gap"))).toBe(false)
  })

  it("flags an integration gap when index.html does not load the runtime JS at all", async () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("create-html", {
          objective: "Create HTML shell",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file", "read_file", "browser_check"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/app/index.html"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
        makeSubagentStep("create-js", {
          objective: "Create JS logic",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file", "read_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/app/game-logic.js", "tmp/app/ui-logic.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
      ],
      edges: [{ from: "create-html", to: "create-js" }],
    })

    const pipelineResult: PipelineResult = {
      status: "completed",
      completedSteps: 2,
      totalSteps: 2,
      stepResults: new Map([
        ["create-html", { name: "create-html", status: "completed", output: "wrote tmp/app/index.html", durationMs: 1 }],
        ["create-js", { name: "create-js", status: "completed", output: "wrote tmp/app/game-logic.js and tmp/app/ui-logic.js", durationMs: 1 }],
      ]),
    }

    const tools: Tool[] = [
      {
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        async execute(args) {
          const path = String(args.path)
          if (path.endsWith("index.html")) return "<html><body><div id='chessboard'></div><p id='status'></p></body></html>"
          if (path.endsWith("game-logic.js")) return "export function initializeBoard() { return [] }"
          if (path.endsWith("ui-logic.js")) return "import { initializeBoard } from './game-logic.js'\nexport function renderBoard() { return initializeBoard() }"
          return "Error: not found"
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
          return "No errors"
        },
      },
    ]

    const assessments = await runDeterministicProbes(plan, pipelineResult, tools)
    const htmlStep = assessments.find(a => a.stepName === "create-html")
    expect(htmlStep).toBeDefined()
    expect(htmlStep?.issues.some(i => i.includes("Integration gap") && i.includes("Runtime code will never load"))).toBe(true)
    expect(htmlStep?.outcome).not.toBe("pass")
  })

  it("flags browser module mismatch when HTML loads a CommonJS runtime file directly", async () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("create-html", {
          objective: "Create HTML shell",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file", "read_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/app/index.html"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
        makeSubagentStep("create-js", {
          objective: "Create JS logic",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file", "read_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/app/game-logic.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
      ],
      edges: [{ from: "create-html", to: "create-js" }],
    })

    const pipelineResult: PipelineResult = {
      status: "completed",
      completedSteps: 2,
      totalSteps: 2,
      stepResults: new Map([
        ["create-html", { name: "create-html", status: "completed", output: "wrote tmp/app/index.html", durationMs: 1 }],
        ["create-js", { name: "create-js", status: "completed", output: "wrote tmp/app/game-logic.js", durationMs: 1 }],
      ]),
    }

    const tools: Tool[] = [
      {
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        async execute(args) {
          const path = String(args.path)
          if (path.endsWith("index.html")) return "<html><body><script type='module' src='game-logic.js'></script></body></html>"
          if (path.endsWith("game-logic.js")) return "function initializeBoard() { return [] }\nmodule.exports = { initializeBoard }"
          return "Error: not found"
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
    ]

    const assessments = await runDeterministicProbes(plan, pipelineResult, tools)
    const htmlStep = assessments.find(a => a.stepName === "create-html")
    expect(htmlStep).toBeDefined()
    expect(htmlStep?.issues.some(i => i.includes("Browser module mismatch") && i.includes("CommonJS"))).toBe(true)
    expect(htmlStep?.outcome).not.toBe("pass")
  })

  it("flags the exact inconsistent browser contract when UI assumes globals but logic uses CommonJS", async () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("create-html", {
          objective: "Create HTML shell",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file", "read_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/app/index.html"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
        makeSubagentStep("create-ui", {
          objective: "Create UI runtime",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file", "read_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/app/game_ui.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
        makeSubagentStep("create-logic", {
          objective: "Create logic runtime",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file", "read_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/app/game_logic.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
      ],
      edges: [
        { from: "create-html", to: "create-ui" },
        { from: "create-ui", to: "create-logic" },
      ],
    })

    const pipelineResult: PipelineResult = {
      status: "completed",
      completedSteps: 3,
      totalSteps: 3,
      stepResults: new Map([
        ["create-html", { name: "create-html", status: "completed", output: "wrote tmp/app/index.html", durationMs: 1 }],
        ["create-ui", { name: "create-ui", status: "completed", output: "wrote tmp/app/game_ui.js", durationMs: 1 }],
        ["create-logic", { name: "create-logic", status: "completed", output: "wrote tmp/app/game_logic.js", durationMs: 1 }],
      ]),
    }

    const tools: Tool[] = [
      {
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        async execute(args) {
          const path = String(args.path)
          if (path.endsWith("index.html")) {
            return "<html><body><script type='module' src='./game_ui.js'></script><script type='module' src='./game_logic.js'></script></body></html>"
          }
          if (path.endsWith("game_ui.js")) {
            return [
              "export function bootGame() {",
              "  const board = initializeBoard()",
              "  const legal = validateMove(board, { from: 'e2', to: 'e4' })",
              "  return updateGameState(board, legal)",
              "}",
            ].join("\n")
          }
          if (path.endsWith("game_logic.js")) {
            return "function initializeBoard() { return [] }\nfunction validateMove() { return true }\nfunction updateGameState(board) { return board }\nmodule.exports = { initializeBoard, validateMove, updateGameState }"
          }
          return "Error: not found"
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
    ]

    const assessments = await runDeterministicProbes(plan, pipelineResult, tools)
    const htmlStep = assessments.find(a => a.stepName === "create-html")
    const uiStep = assessments.find(a => a.stepName === "create-ui")
    expect(htmlStep).toBeDefined()
    expect(uiStep).toBeDefined()
    expect(htmlStep?.issues.some(i => i.includes("Browser module mismatch") && i.includes("CommonJS"))).toBe(true)
    expect(uiStep?.issues.some(i => i.includes("Missing helper dependency/dependencies") && i.includes("initializeBoard()") && i.includes("validateMove()") && i.includes("updateGameState()"))).toBe(true)
    expect(htmlStep?.outcome).not.toBe("pass")
    expect(uiStep?.outcome).not.toBe("pass")
  })

  it("accepts runtime wiring through an ESM entry module import graph", async () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("create-html", {
          objective: "Create HTML shell",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file", "read_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/app/index.html"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
        makeSubagentStep("create-js", {
          objective: "Create JS logic",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file", "read_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/app/main.js", "tmp/app/game-logic.js", "tmp/app/ui-logic.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
      ],
      edges: [{ from: "create-html", to: "create-js" }],
    })

    const pipelineResult: PipelineResult = {
      status: "completed",
      completedSteps: 2,
      totalSteps: 2,
      stepResults: new Map([
        ["create-html", { name: "create-html", status: "completed", output: "wrote tmp/app/index.html", durationMs: 1 }],
        ["create-js", { name: "create-js", status: "completed", output: "wrote tmp/app/main.js", durationMs: 1 }],
      ]),
    }

    const tools: Tool[] = [
      {
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        async execute(args) {
          const path = String(args.path)
          if (path.endsWith("index.html")) return "<html><body><script type='module' src='./main.js'></script></body></html>"
          if (path.endsWith("main.js")) return "import { initializeBoard } from './game-logic.js'\nimport { mountUi } from './ui-logic.js'\nmountUi(initializeBoard())"
          if (path.endsWith("game-logic.js")) return "export function initializeBoard() { return [] }"
          if (path.endsWith("ui-logic.js")) return "export function mountUi(board) { return board }"
          return "Error: not found"
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
    ]

    const assessments = await runDeterministicProbes(plan, pipelineResult, tools)
    const htmlStep = assessments.find(a => a.stepName === "create-html")
    expect(htmlStep).toBeDefined()
    expect(htmlStep?.issues.some(i => i.includes("Integration gap"))).toBe(false)
    expect(htmlStep?.issues.some(i => i.includes("Browser module mismatch"))).toBe(false)
  })

  it("flags browser module mismatch when runtime JS is loaded without type=module", async () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("create-html", {
          objective: "Create HTML shell",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file", "read_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/app/index.html"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
        makeSubagentStep("create-js", {
          objective: "Create JS logic",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file", "read_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/app/main.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
      ],
      edges: [{ from: "create-html", to: "create-js" }],
    })

    const pipelineResult: PipelineResult = {
      status: "completed",
      completedSteps: 2,
      totalSteps: 2,
      stepResults: new Map([
        ["create-html", { name: "create-html", status: "completed", output: "wrote tmp/app/index.html", durationMs: 1 }],
        ["create-js", { name: "create-js", status: "completed", output: "wrote tmp/app/main.js", durationMs: 1 }],
      ]),
    }

    const tools: Tool[] = [
      {
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        async execute(args) {
          const path = String(args.path)
          if (path.endsWith("index.html")) return "<html><body><script src='main.js'></script></body></html>"
          if (path.endsWith("main.js")) return "export function boot() { return true }"
          return "Error: not found"
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
    ]

    const assessments = await runDeterministicProbes(plan, pipelineResult, tools)
    const htmlStep = assessments.find(a => a.stepName === "create-html")
    expect(htmlStep).toBeDefined()
    expect(htmlStep?.issues.some(i => i.includes("without type=\"module\""))).toBe(true)
  })

  it("flags broken local import/export bindings so helper dependencies cannot hide behind bad ESM wiring", async () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("create-js", {
          objective: "Create browser modules",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file", "read_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/app/main.js", "tmp/app/game-logic.js"],
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
        ["create-js", { name: "create-js", status: "completed", output: "wrote tmp/app/main.js", durationMs: 1 }],
      ]),
    }

    const tools: Tool[] = [
      {
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        async execute(args) {
          const path = String(args.path)
          if (path.endsWith("main.js")) return "import { hasObstacles } from './game-logic.js'\nexport function validateMove(board, move) { return hasObstacles(board, move) }"
          if (path.endsWith("game-logic.js")) return "export function initializeBoard() { return [] }"
          return "Error: not found"
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
    ]

    const assessments = await runDeterministicProbes(plan, pipelineResult, tools)
    const step = assessments.find(a => a.stepName === "create-js")
    expect(step).toBeDefined()
    expect(step?.issues.some(i => i.includes("Import/export mismatch") && i.includes("hasObstacles"))).toBe(true)
  })

  it("flags unresolved helper dependencies inside a JS artifact", async () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("implement-rules", {
          objective: "Implement move validation",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file", "read_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/game_logic.js"],
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
        ["implement-rules", { name: "implement-rules", status: "completed", output: "wrote tmp/game_logic.js", durationMs: 1 }],
      ]),
    }

    const tools: Tool[] = [
      {
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        async execute(args) {
          const path = String(args.path)
          if (path.endsWith("game_logic.js")) {
            return [
              "function validateMove(board, move) {",
              "  if (hasObstacles(board, move)) return false",
              "  return isKingUnderThreat(board, move) === false",
              "}",
            ].join("\n")
          }
          return "Error: not found"
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
    ]

    const assessments = await runDeterministicProbes(plan, pipelineResult, tools)
    const step = assessments.find(a => a.stepName === "implement-rules")
    expect(step).toBeDefined()
    expect(step?.issues.some(i => i.includes("Missing helper dependency/dependencies") && i.includes("hasObstacles()") && i.includes("isKingUnderThreat()"))).toBe(true)
  })

  it("flags temporal-dead-zone style use-before-declaration in a JS artifact", async () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("implement-rules", {
          objective: "Implement move validation",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file", "read_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/game_logic.js"],
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
        ["implement-rules", { name: "implement-rules", status: "completed", output: "wrote tmp/game_logic.js", durationMs: 1 }],
      ]),
    }

    const tools: Tool[] = [
      {
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        async execute(args) {
          const path = String(args.path)
          if (path.endsWith("game_logic.js")) {
            return [
              "function validateMove(startPos, endPos) {",
              "  if (endPos.row === startPos.row + direction) return true",
              "  const direction = -1",
              "  return false",
              "}",
            ].join("\n")
          }
          return "Error: not found"
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
    ]

    const assessments = await runDeterministicProbes(plan, pipelineResult, tools)
    const step = assessments.find(a => a.stepName === "implement-rules")
    expect(step).toBeDefined()
    expect(step?.issues.some(i => i.includes("temporal-dead-zone/use-before-declaration") && i.includes("direction"))).toBe(true)
  })

  it("flags missing stylesheet rules for CSS classes referenced by browser code", async () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("create-ui", {
          objective: "Create browser UI",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file", "read_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/app/game_ui.js", "tmp/app/styles.css"],
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
        ["create-ui", { name: "create-ui", status: "completed", output: "wrote tmp/app/game_ui.js and tmp/app/styles.css", durationMs: 1 }],
      ]),
    }

    const tools: Tool[] = [
      {
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        async execute(args) {
          const path = String(args.path)
          if (path.endsWith("game_ui.js")) return "cell.classList.add('highlight-move')\ncell.classList.remove('selected')"
          if (path.endsWith("styles.css")) return ".selected { outline: 1px solid red; }"
          return "Error: not found"
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
    ]

    const assessments = await runDeterministicProbes(plan, pipelineResult, tools)
    const step = assessments.find(a => a.stepName === "create-ui")
    expect(step).toBeDefined()
    expect(step?.issues.some(i => i.includes("Style integration gap") && i.includes(".highlight-move"))).toBe(true)
  })

  it("flags flat nth-child striping as suspicious for multi-column grid boards", async () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("create-styles", {
          objective: "Create board styles",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file", "read_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/app/styles.css"],
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
        ["create-styles", { name: "create-styles", status: "completed", output: "wrote tmp/app/styles.css", durationMs: 1 }],
      ]),
    }

    const tools: Tool[] = [
      {
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        async execute(args) {
          const path = String(args.path)
          if (path.endsWith("styles.css")) {
            return [
              ".board { display: grid; grid-template-columns: repeat(8, 1fr); }",
              ".square:nth-child(odd) { background: #fff; }",
              ".square:nth-child(even) { background: #000; }",
            ].join("\n")
          }
          return "Error: not found"
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
    ]

    const assessments = await runDeterministicProbes(plan, pipelineResult, tools)
    const step = assessments.find(a => a.stepName === "create-styles")
    expect(step).toBeDefined()
    expect(step?.issues.some(i => i.includes("Potential 2D grid styling bug") && i.includes("nth-child"))).toBe(true)
  })

  it("does not flag scope violation when writing declared required source artifact", async () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("create-html", {
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file", "read_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/index.html"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
        makeSubagentStep("implement-js", {
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file", "read_file"],
            requiredSourceArtifacts: ["tmp/index.html"],
            targetArtifacts: ["tmp/chess.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
      ],
      edges: [{ from: "create-html", to: "implement-js" }],
    })

    const pipelineResult: PipelineResult = {
      status: "completed",
      completedSteps: 2,
      totalSteps: 2,
      stepResults: new Map([
        ["create-html", { name: "create-html", status: "completed", output: "wrote tmp/index.html", durationMs: 1 }],
        ["implement-js", {
          name: "implement-js",
          status: "completed",
          output: "Updated `tmp/index.html` and wrote `tmp/chess.js`",
          durationMs: 1,
          toolCalls: [
            { name: "read_file", args: { path: "tmp/index.html" }, result: "<html></html>", isError: false },
            { name: "write_file", args: { path: "tmp/index.html", content: "<html><script src=\"chess.js\"></script></html>" }, result: "ok", isError: false },
            { name: "write_file", args: { path: "tmp/chess.js", content: "console.log('ok')" }, result: "ok", isError: false },
          ],
        }],
      ]),
    }

    const tools: Tool[] = [
      {
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        async execute(args) {
          const path = String(args.path)
          if (path.endsWith("tmp/index.html")) return "<html><script src=\"chess.js\"></script></html>"
          if (path.endsWith("tmp/chess.js")) return "console.log('ok')"
          return "Error: not found"
        },
      },
    ]

    const assessments = await runDeterministicProbes(plan, pipelineResult, tools)
    const jsStep = assessments.find(a => a.stepName === "implement-js")
    expect(jsStep).toBeDefined()
    expect(jsStep?.issues.some(i => i.includes("SCOPE VIOLATION"))).toBe(false)
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

  it("recovers write_file EISDIR as directory scaffold", async () => {
    const commands: string[] = []
    const writeFileTool: Tool = {
      name: "write_file",
      description: "write",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
      async execute() {
        return "Error: EISDIR: illegal operation on a directory, open 'tmp/game'"
      },
    }
    const runCommandTool: Tool = {
      name: "run_command",
      description: "run",
      parameters: { type: "object", properties: { command: { type: "string" } } },
      async execute(args) {
        commands.push(String(args.command ?? ""))
        return "ok"
      },
    }

    const plan = makePlan({
      steps: [
        {
          name: "scaffold-dir",
          stepType: "deterministic_tool",
          tool: "write_file",
          args: { path: "tmp/game", content: "" },
        },
      ],
      edges: [],
    })

    const result = await executePipeline(plan, [writeFileTool, runCommandTool], async () => ({ output: "" }))

    expect(result.status).toBe("completed")
    expect(commands).toContain('mkdir -p "tmp/game"')
    expect(result.stepResults.get("scaffold-dir")?.status).toBe("completed")
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
      steps: [makeSubagentStep("build-game", { acceptanceCriteria: [] })],
      edges: [],
    })

    const result = await executePipeline(
      plan,
      [],
      async (step) => {
        delegatedTasks.push(step.name)
        return {
          output: "Build completed successfully. Created game.js with full logic.",
          toolCalls: [
            {
              name: "read_file",
              args: { path: "game.js" },
              result: "// previous state",
              isError: false,
            },
            {
              name: "write_file",
              args: { path: "game.js", content: "export const ready = true" },
              result: "Successfully wrote to game.js",
              isError: false,
            },
            {
              name: "read_file",
              args: { path: "game.js" },
              result: "export const ready = true",
              isError: false,
            },
          ],
        }
      },
    )

    expect(result.status).toBe("completed")
    expect(delegatedTasks).toContain("build-game")
  })

  it("injects prior artifacts from tool evidence, not narrative mentions", async () => {
    const receivedObjectives = new Map<string, string>()
    const plan = makePlan({
      steps: [
        makeSubagentStep("create-html", {
          objective: "Create HTML shell",
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file", "read_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/chess/index.html", "tmp/chess/logic.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
        makeSubagentStep("create-pieces", {
          objective: "Create piece rendering logic",
          dependsOn: ["create-html"],
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["write_file", "read_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/chess/pieces.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
      ],
      edges: [{ from: "create-html", to: "create-pieces" }],
    })

    const priorResults = new Map<string, {
      name: string
      status: "completed"
      output: string
      durationMs: number
      toolCalls: Array<{ name: string; args: Record<string, unknown>; result: string; isError: boolean }>
    }>([
      [
        "create-html",
        {
          name: "create-html",
          status: "completed",
          output: "Created tmp/chess/index.html. Future integration will add logic.js.",
          durationMs: 5,
          toolCalls: [
            {
              name: "write_file",
              args: { path: "tmp/chess/index.html", content: "<html></html>" },
              result: "Successfully wrote to tmp/chess/index.html",
              isError: false,
            },
            {
              name: "read_file",
              args: { path: "tmp/chess/index.html" },
              result: "<html></html>",
              isError: false,
            },
          ],
        },
      ],
    ])

    const result = await executePipeline(plan, [], async (step) => {
      receivedObjectives.set(step.name, step.objective)

      return {
        output: "Created tmp/chess/pieces.js",
        toolCalls: [
          {
            name: "read_file",
            args: { path: "tmp/chess/index.html" },
            result: "<html></html>",
            isError: false,
          },
          {
            name: "write_file",
            args: { path: "tmp/chess/pieces.js", content: "export const pieces = []" },
            result: "Successfully wrote to tmp/chess/pieces.js",
            isError: false,
          },
          {
            name: "read_file",
            args: { path: "tmp/chess/pieces.js" },
            result: "export const pieces = []",
            isError: false,
          },
        ],
      }
    }, { priorResults })

    expect(result.status).toBe("completed")
    const step2Objective = receivedObjectives.get("create-pieces") ?? ""
    expect(step2Objective).toContain("tmp/chess/index.html")
    expect(step2Objective).not.toContain("logic.js")
  })

  it("fails subagent step when write integrity warnings are present", async () => {
    const plan = makePlan({
      steps: [makeSubagentStep("build-game")],
      edges: [],
    })

    const result = await executePipeline(
      plan,
      [],
      async () => ({
        output: "Completed",
        toolCalls: [
          {
            name: "write_file",
            args: { path: "game.js", content: "..." },
            result: "⚠ WRITTEN WITH ISSUES to game.js — stub/placeholder code detected",
            isError: false,
          },
        ],
      }),
    )

    expect(result.status).toBe("failed")
    const step = result.stepResults.get("build-game")
    expect(step?.status).toBe("failed")
    expect(step?.error).toContain("integrity violations")
  })

  it("fails subagent step when a child browser_check reports runtime errors", async () => {
    const plan = makePlan({
      steps: [makeSubagentStep("build-ui", {
        executionContext: {
          workspaceRoot: ".",
          allowedReadRoots: ["."],
          allowedWriteRoots: ["."],
          allowedTools: ["write_file", "read_file", "browser_check"],
          requiredSourceArtifacts: [],
          targetArtifacts: ["tmp/index.html", "tmp/styles.css"],
          effectClass: "filesystem_write",
          verificationMode: "none",
          artifactRelations: [],
        },
      })],
      edges: [],
    })

    const result = await executePipeline(
      plan,
      [],
      async () => ({
        output: "Completed UI step.",
        toolCalls: [
          {
            name: "write_file",
            args: { path: "tmp/index.html", content: "<html></html>" },
            result: "Successfully wrote to tmp/index.html",
            isError: false,
          },
          {
            name: "browser_check",
            args: { path: "tmp/index.html" },
            result: "## Uncaught Exceptions (1)\n  - SyntaxError: Unexpected token ':'\n\nTotal: 1 error(s), 0 warning(s)",
            isError: true,
          },
          {
            name: "read_file",
            args: { path: "tmp/index.html" },
            result: "<html></html>",
            isError: false,
          },
        ],
      }),
    )

    expect(result.status).toBe("failed")
    const step = result.stepResults.get("build-ui")
    expect(step?.status).toBe("failed")
    expect(step?.error).toContain("browser_check")
    expect(step?.error).toContain("verification failed")
  })

  it("fails subagent step when delegation contract evidence is missing", async () => {
    const plan = makePlan({
      steps: [makeSubagentStep("build-game")],
      edges: [],
    })

    const result = await executePipeline(
      plan,
      [],
      async () => ({
        output: "Done.",
        toolCalls: [],
      }),
    )

    expect(result.status).toBe("failed")
    const step = result.stepResults.get("build-game")
    expect(step?.status).toBe("failed")
    expect(step?.validationCode).toBeDefined()
    expect(step?.error).toContain("zero tool-call evidence")
  })

  it("retries once with write-first guidance on missing_file_mutation_evidence", async () => {
    const plan = makePlan({
      steps: [makeSubagentStep("build-game", {
        executionContext: {
          workspaceRoot: ".",
          allowedReadRoots: ["."],
          allowedWriteRoots: ["."],
          allowedTools: ["write_file", "read_file"],
          requiredSourceArtifacts: [],
          targetArtifacts: ["game.js"],
          effectClass: "filesystem_write",
          verificationMode: "none",
          artifactRelations: [],
        },
      })],
      edges: [],
    })

    let calls = 0
    let secondObjective = ""
    const result = await executePipeline(
      plan,
      [],
      async (step) => {
        calls += 1
        if (calls === 1) {
          return {
            output: "Done.",
            toolCalls: [
              {
                name: "read_file",
                args: { path: "game.js" },
                result: "// existing",
                isError: false,
              },
            ],
          }
        }
        secondObjective = step.objective
        return {
          output: "Wrote game.js",
          toolCalls: [
            {
              name: "write_file",
              args: { path: "game.js", content: "export const ready = true" },
              result: "Successfully wrote to game.js",
              isError: false,
            },
          ],
        }
      },
    )

    expect(calls).toBe(2)
    expect(secondObjective).toContain("MANDATORY RETRY")
    expect(result.status).toBe("failed")
    expect(result.stepResults.get("build-game")?.status).toBe("failed")
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

  it("switches retry guidance away from replace_in_file after repeated old_string misses", async () => {
    let seenObjective = ""
    const plan = makePlan({
      steps: [makeSubagentStep("fix-ui")],
      edges: [],
    })

    const priorResults = new Map([
      [
        "fix-ui",
        {
          name: "fix-ui",
          status: "failed" as const,
          error: "previous attempt failed",
          durationMs: 1,
          toolCalls: [
            {
              name: "replace_in_file",
              args: { path: "ui.js", old_string: "a", new_string: "b" },
              result: "Error: old_string not found in \"ui.js\"",
              isError: false,
            },
            {
              name: "replace_in_file",
              args: { path: "ui.js", old_string: "c", new_string: "d" },
              result: "Error: old_string not found in \"ui.js\"",
              isError: false,
            },
          ],
        },
      ],
    ])

    const retryFeedback = new Map<string, readonly string[]>([
      ["fix-ui", ["Preserve working code while fixing UI click behavior"]],
    ])

    const result = await executePipeline(
      plan,
      [
        {
          name: "replace_in_file",
          description: "replace",
          parameters: { type: "object", properties: {} },
          async execute() {
            return "ok"
          },
        },
      ],
      async (step) => {
        seenObjective = step.objective
        return {
          output: "done",
          toolCalls: [
            {
              name: "write_file",
              args: { path: "game.js", content: "export const ok = true" },
              result: "Successfully wrote to game.js",
              isError: false,
            },
          ],
        }
      },
      { priorResults, retryFeedback },
    )

    expect(result.status).toBe("failed")
    expect(seenObjective).toContain("replace_in_file appears brittle")
    expect(seenObjective).toContain("Use write_file with FULL-FILE preservation")
  })

  it("compiles verifier findings into an autonomous repair plan for code/spec mismatches", async () => {
    let seenObjective = ""
    const plan = makePlan({
      steps: [makeSubagentStep("repair-engine", {
        executionContext: {
          workspaceRoot: ".",
          allowedReadRoots: ["."],
          allowedWriteRoots: ["."],
          allowedTools: ["read_file", "write_file"],
          requiredSourceArtifacts: ["tmp/BLUEPRINT.md"],
          targetArtifacts: ["tmp/engine.py"],
          effectClass: "filesystem_write",
          verificationMode: "none",
          artifactRelations: [],
        },
      })],
      edges: [],
    })

    const retryFeedback = new Map<string, readonly string[]>([
      ["repair-engine", [
        "SPEC FUNCTION MISMATCH: tmp/engine.py is missing blueprint functions validate_move, apply_move from tmp/BLUEPRINT.md",
        "PROCESS AUDIT FAILED: step repair-engine read tmp/BLUEPRINT.md only after starting file mutations",
      ]],
    ])

    const result = await executePipeline(
      plan,
      [],
      async (step) => {
        seenObjective = step.objective
        return { output: "done", toolCalls: [] }
      },
      { retryFeedback },
    )

    expect(result.status).toBe("failed")
    expect(seenObjective).toContain("AUTONOMOUS REPAIR PLAN")
    expect(seenObjective).toContain("implement exactly these missing functions")
    expect(seenObjective).toContain("Reorder the workflow: read spec first")
    expect(seenObjective).toContain("Python: preserve function names and call contracts exactly")
  })

  it("adds shell-specific autonomous retry guidance for PowerShell and Windows CMD artifacts", async () => {
    let seenObjective = ""
    const plan = makePlan({
      steps: [makeSubagentStep("repair-shell", {
        executionContext: {
          workspaceRoot: ".",
          allowedReadRoots: ["."],
          allowedWriteRoots: ["."],
          allowedTools: ["read_file", "write_file"],
          requiredSourceArtifacts: ["tmp/BLUEPRINT.md"],
          targetArtifacts: ["tmp/install.ps1", "tmp/bootstrap.cmd"],
          effectClass: "filesystem_write",
          verificationMode: "none",
          artifactRelations: [],
        },
      })],
      edges: [],
    })

    const retryFeedback = new Map<string, readonly string[]>([
      ["repair-shell", [
        "SPEC MAPPING MISSING: target artifact tmp/install.ps1 does not map to any file declared in tmp/BLUEPRINT.md",
        "Syntax error in \"tmp/bootstrap.cmd\": unexpected token",
      ]],
    ])

    const result = await executePipeline(
      plan,
      [],
      async (step) => {
        seenObjective = step.objective
        return { output: "done", toolCalls: [] }
      },
      { retryFeedback },
    )

    expect(result.status).toBe("failed")
    expect(seenObjective).toContain("Map each target artifact to a concrete blueprint file/section")
    expect(seenObjective).toContain("Fix syntax and parse errors first")
    expect(seenObjective).toContain("PowerShell: preserve cmdlet/function names")
    expect(seenObjective).toContain("Windows CMD: use cmd.exe syntax")
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
// Spec-driven verifier evidence
// ============================================================================

describe("Verifier: spec-driven structural and process evidence", () => {
  it("fails blueprint steps that declare a different artifact set than the plan", async () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("generate_blueprint", {
          objective: "Create BLUEPRINT.md",
          acceptanceCriteria: ["Blueprint declares the planned files exactly"],
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["read_file", "write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/BLUEPRINT.md"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
            role: "writer",
          },
        }),
        makeSubagentStep("implement_game_logic", {
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["read_file", "write_file"],
            requiredSourceArtifacts: ["tmp/BLUEPRINT.md"],
            targetArtifacts: ["tmp/game_logic.js", "tmp/index.html"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
            role: "writer",
          },
        }),
      ],
      edges: [],
    })

    const pipelineResult: PipelineResult = {
      status: "completed",
      completedSteps: 2,
      totalSteps: 2,
      stepResults: new Map([
        ["generate_blueprint", {
          name: "generate_blueprint",
          status: "completed",
          output: "wrote tmp/BLUEPRINT.md",
          durationMs: 1,
          toolCalls: [
            { name: "write_file", args: { path: "tmp/BLUEPRINT.md", content: "# Blueprint" }, result: "ok", isError: false },
            { name: "read_file", args: { path: "tmp/BLUEPRINT.md" }, result: "ok", isError: false },
          ],
        }],
        ["implement_game_logic", {
          name: "implement_game_logic",
          status: "completed",
          output: "wrote tmp/game_logic.js and tmp/index.html",
          durationMs: 1,
          toolCalls: [
            { name: "read_file", args: { path: "tmp/BLUEPRINT.md" }, result: "ok", isError: false },
          ],
        }],
      ]),
    }

    const tools: Tool[] = [
      {
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        async execute(args) {
          const path = String(args.path)
          if (path.endsWith("BLUEPRINT.md")) {
            return [
              "# Chess Blueprint",
              "",
              makeBlueprintContract(["game/index.html", "game/rules.js"]),
              "",
              "`game/index.html`",
              "- browser shell",
              "`game/rules.js`",
              "- chess rules engine",
            ].join("\n")
          }
          if (path.endsWith("game_logic.js")) return "export function validateMove() { return true }"
          if (path.endsWith("index.html")) return "<main>Chess</main>"
          return "Error: not found"
        },
      },
    ]

    const assessments = await runDeterministicProbes(plan, pipelineResult, tools)
    const step = assessments.find(a => a.stepName === "generate_blueprint")
    expect(step).toBeDefined()
    expect(step?.issues.some(i => i.includes("BLUEPRINT ARTIFACT COVERAGE FAILED") && i.includes("tmp/game_logic.js"))).toBe(true)
    expect(step?.issues.some(i => i.includes("BLUEPRINT ARTIFACT DRIFT") && i.includes("game/rules.js"))).toBe(true)
  })

  it("detects missing blueprint functions for non-web languages like Python", async () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("engine-step", {
          objective: "Implement the Python engine from BLUEPRINT.md",
          acceptanceCriteria: ["Engine follows the contracts defined in BLUEPRINT.md"],
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["read_file", "write_file"],
            requiredSourceArtifacts: ["tmp/BLUEPRINT.md"],
            targetArtifacts: ["tmp/engine.py"],
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
        ["engine-step", {
          name: "engine-step",
          status: "completed",
          output: "wrote tmp/engine.py",
          durationMs: 1,
          toolCalls: [
            { name: "read_file", args: { path: "tmp/BLUEPRINT.md" }, result: "ok", isError: false },
            { name: "write_file", args: { path: "tmp/engine.py", content: "def render_board(board):\n    return board\n" }, result: "ok", isError: false },
          ],
        }],
      ]),
    }

    const tools: Tool[] = [
      {
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        async execute(args) {
          const path = String(args.path)
          if (path.endsWith("BLUEPRINT.md")) {
            return [
              "# Engine Blueprint",
              "",
              "`tmp/engine.py`",
              "- function `validate_move(board, move)` validates legal moves",
              "- function `render_board(board)` renders the board state",
            ].join("\n")
          }
          if (path.endsWith("engine.py")) return "def render_board(board):\n    return board\n"
          return "Error: not found"
        },
      },
    ]

    const assessments = await runDeterministicProbes(plan, pipelineResult, tools)
    const step = assessments.find(a => a.stepName === "engine-step")
    expect(step).toBeDefined()
    expect(step?.issues.some(i => i.includes("SPEC FUNCTION MISMATCH") && i.includes("validate_move"))).toBe(true)
  })

  it("flags weak machine function contracts and prose drift inside BLUEPRINT.md", async () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("generate_blueprint", {
          objective: "Create BLUEPRINT.md with exact function contracts",
          acceptanceCriteria: ["Blueprint defines exact signatures for every exported function"],
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["read_file", "write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/BLUEPRINT.md"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
            role: "writer",
          },
        }),
        makeSubagentStep("implement_engine", {
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["read_file", "write_file"],
            requiredSourceArtifacts: ["tmp/BLUEPRINT.md"],
            targetArtifacts: ["tmp/engine.ts"],
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
      completedSteps: 2,
      totalSteps: 2,
      stepResults: new Map([
        ["generate_blueprint", {
          name: "generate_blueprint",
          status: "completed",
          output: "wrote tmp/BLUEPRINT.md",
          durationMs: 1,
          toolCalls: [
            { name: "write_file", args: { path: "tmp/BLUEPRINT.md", content: "# Blueprint" }, result: "ok", isError: false },
            { name: "read_file", args: { path: "tmp/BLUEPRINT.md" }, result: "ok", isError: false },
          ],
        }],
        ["implement_engine", {
          name: "implement_engine",
          status: "completed",
          output: "wrote tmp/engine.ts",
          durationMs: 1,
          toolCalls: [
            { name: "read_file", args: { path: "tmp/BLUEPRINT.md" }, result: "ok", isError: false },
            { name: "write_file", args: { path: "tmp/engine.ts", content: "export function validateMove(state, move) { return true }" }, result: "ok", isError: false },
          ],
        }],
      ]),
    }

    const tools: Tool[] = [
      {
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        async execute(args) {
          const path = String(args.path)
          if (path.endsWith("BLUEPRINT.md")) {
            return [
              "# Engine Blueprint",
              "",
              "```blueprint-contract",
              JSON.stringify({
                version: 1,
                files: [
                  {
                    path: "tmp/engine.ts",
                    purpose: "Move validation engine",
                    functions: [{ name: "validateMove", signature: "validateMove()" }],
                  },
                ],
                sharedTypes: [],
              }, null, 2),
              "```",
              "",
              "`tmp/engine.ts`",
              "- function `validateMove(state: GameState, move: Move): boolean` validates whether a move is legal",
              "- function `applyMove(state: GameState, move: Move): GameState` returns the next state",
            ].join("\n")
          }
          if (path.endsWith("engine.ts")) return "export function validateMove(state, move) { return true }"
          return "Error: not found"
        },
      },
    ]

    const assessments = await runDeterministicProbes(plan, pipelineResult, tools)
    const step = assessments.find(a => a.stepName === "generate_blueprint")
    expect(step).toBeDefined()
    expect(step?.issues.some(i => i.includes("BLUEPRINT FUNCTION CONTRACT WEAK") && i.includes("validateMove()"))).toBe(true)
    expect(step?.issues.some(i => i.includes("BLUEPRINT FUNCTION CONTRACT DRIFT") && i.includes("applyMove"))).toBe(true)
  })

  it("surfaces shared-type contract drift and weak shared-type metadata deterministically", async () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("generate_blueprint", {
          objective: "Create BLUEPRINT.md with shared data contracts",
          acceptanceCriteria: ["Blueprint declares shared data types used across files"],
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["read_file", "write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/BLUEPRINT.md"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
            role: "writer",
          },
        }),
        makeSubagentStep("implement_engine", {
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["read_file", "write_file"],
            requiredSourceArtifacts: ["tmp/BLUEPRINT.md"],
            targetArtifacts: ["tmp/engine.ts", "tmp/ui.ts"],
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
      completedSteps: 2,
      totalSteps: 2,
      stepResults: new Map([
        ["generate_blueprint", {
          name: "generate_blueprint",
          status: "completed",
          output: "wrote tmp/BLUEPRINT.md",
          durationMs: 1,
          toolCalls: [
            { name: "write_file", args: { path: "tmp/BLUEPRINT.md", content: "# Blueprint" }, result: "ok", isError: false },
            { name: "read_file", args: { path: "tmp/BLUEPRINT.md" }, result: "ok", isError: false },
          ],
        }],
        ["implement_engine", {
          name: "implement_engine",
          status: "completed",
          output: "wrote tmp/engine.ts and tmp/ui.ts",
          durationMs: 1,
          toolCalls: [
            { name: "read_file", args: { path: "tmp/BLUEPRINT.md" }, result: "ok", isError: false },
          ],
        }],
      ]),
    }

    const tools: Tool[] = [
      {
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        async execute(args) {
          const path = String(args.path)
          if (path.endsWith("BLUEPRINT.md")) {
            return [
              "# Shared Data Blueprint",
              "",
              "```blueprint-contract",
              JSON.stringify({
                version: 1,
                files: [
                  { path: "tmp/engine.ts", purpose: "Rules engine", functions: [] },
                  { path: "tmp/ui.ts", purpose: "UI renderer", functions: [] },
                ],
                sharedTypes: [
                  { name: "GameState", definition: "", usedBy: [] },
                ],
              }, null, 2),
              "```",
              "",
              "## Shared Data Types",
              "- `GameState` stores the canonical board and turn metadata",
              "- `Move` carries from/to coordinates and promotion intent",
            ].join("\n")
          }
          if (path.endsWith("engine.ts")) return "export const engine = {}"
          if (path.endsWith("ui.ts")) return "export const ui = {}"
          return "Error: not found"
        },
      },
    ]

    const assessments = await runDeterministicProbes(plan, pipelineResult, tools)
    const step = assessments.find(a => a.stepName === "generate_blueprint")
    expect(step).toBeDefined()
    expect(step?.issues.some(i => i.includes("BLUEPRINT SHARED TYPE CONTRACT WEAK") && i.includes("GameState"))).toBe(true)
    expect(step?.issues.some(i => i.includes("BLUEPRINT SHARED TYPE DRIFT") && i.includes("Move"))).toBe(true)
  })

  it("flags blueprint structure mismatches from structural markers instead of keyword heuristics", async () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("ui-step", {
          objective: "Build the UI from BLUEPRINT.md",
          acceptanceCriteria: ["All rendering adheres to the structure defined in BLUEPRINT.md"],
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["read_file", "write_file"],
            requiredSourceArtifacts: ["tmp/BLUEPRINT.md"],
            targetArtifacts: ["tmp/index.html"],
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
        ["ui-step", {
          name: "ui-step",
          status: "completed",
          output: "wrote tmp/index.html",
          durationMs: 1,
          toolCalls: [
            { name: "read_file", args: { path: "tmp/BLUEPRINT.md" }, result: "ok", isError: false },
            { name: "write_file", args: { path: "tmp/index.html", content: "<main><div id='board'></div></main>" }, result: "ok", isError: false },
          ],
        }],
      ]),
    }

    const tools: Tool[] = [
      {
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        async execute(args) {
          const path = String(args.path)
          if (path.endsWith("BLUEPRINT.md")) {
            return [
              "# UI Blueprint",
              "",
              "`tmp/index.html`",
              "- Root layout uses `<main>`",
              "- Board container is `#board`",
              "- Reset control is `.reset-button`",
            ].join("\n")
          }
          if (path.endsWith("index.html")) return "<main><div id='board'></div></main>"
          return "Error: not found"
        },
      },
    ]

    const assessments = await runDeterministicProbes(plan, pipelineResult, tools)
    const step = assessments.find(a => a.stepName === "ui-step")
    expect(step).toBeDefined()
    expect(step?.issues.some(i => i.includes("SPEC STRUCTURE MISMATCH"))).toBe(true)
    expect(step?.issues.some(i => i.includes("acceptance criteria with no code evidence"))).toBe(false)
  })

  it("fails process audit when BLUEPRINT.md is read only after file mutation begins", async () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("ui-step", {
          objective: "Implement blueprint-aligned UI",
          acceptanceCriteria: ["All rendering adheres to the structure defined in BLUEPRINT.md"],
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["read_file", "write_file"],
            requiredSourceArtifacts: ["tmp/BLUEPRINT.md"],
            targetArtifacts: ["tmp/index.html"],
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
        ["ui-step", {
          name: "ui-step",
          status: "completed",
          output: "wrote tmp/index.html",
          durationMs: 1,
          toolCalls: [
            { name: "write_file", args: { path: "tmp/index.html", content: "<main></main>" }, result: "ok", isError: false },
            { name: "read_file", args: { path: "tmp/BLUEPRINT.md" }, result: "ok", isError: false },
          ],
        }],
      ]),
    }

    const tools: Tool[] = [
      {
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        async execute(args) {
          const path = String(args.path)
          if (path.endsWith("BLUEPRINT.md")) return "`tmp/index.html`\n- Root layout uses `<main>`"
          if (path.endsWith("index.html")) return "<main></main>"
          return "Error: not found"
        },
      },
    ]

    const assessments = await runDeterministicProbes(plan, pipelineResult, tools)
    const step = assessments.find(a => a.stepName === "ui-step")
    expect(step).toBeDefined()
    expect(step?.issues.some(i => i.includes("PROCESS AUDIT FAILED"))).toBe(true)
  })

  it("rejects validator blanket claims for complex rule coverage from runtime-only evidence", async () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("runtime_verification", {
          objective: "Verify the chess game in the browser",
          acceptanceCriteria: [
            "All chess rules including castling, en passant, promotion, and checkmate are verified",
            "The game renders and accepts interaction",
          ],
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["read_file", "browser_check"],
            requiredSourceArtifacts: ["tmp/game_logic.js", "tmp/index.html"],
            targetArtifacts: ["tmp/index.html"],
            effectClass: "readonly",
            verificationMode: "browser_check",
            artifactRelations: [],
            role: "validator",
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
        ["runtime_verification", {
          name: "runtime_verification",
          status: "completed",
          output: "The chess game renders successfully in the browser and all chess rules are implemented properly.",
          durationMs: 1,
          toolCalls: [
            { name: "read_file", args: { path: "tmp/game_logic.js" }, result: "ok", isError: false },
            { name: "read_file", args: { path: "tmp/index.html" }, result: "ok", isError: false },
          ],
        }],
      ]),
    }

    const tools: Tool[] = [
      {
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        async execute(args) {
          const path = String(args.path)
          if (path.endsWith("index.html")) return "<main><button>Play</button></main>"
          if (path.endsWith("game_logic.js")) return "export function validateMove() { return true }"
          return "Error: not found"
        },
      },
      {
        name: "browser_check",
        description: "browser",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        async execute() {
          return "No errors"
        },
      },
    ]

    const assessments = await runDeterministicProbes(plan, pipelineResult, tools)
    const step = assessments.find(a => a.stepName === "runtime_verification")
    expect(step).toBeDefined()
    expect(step?.issues.some(i => i.includes("validator/reviewer claimed complex rule coverage from broad runtime evidence only"))).toBe(true)
  })

  it("fails closed before downstream work when the generated blueprint contract paths do not match the plan", async () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("generate_blueprint", {
          objective: "Create BLUEPRINT.md",
          acceptanceCriteria: ["Blueprint declares the planned files exactly"],
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["read_file", "write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/BLUEPRINT.md"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
        makeSubagentStep("implement_game_logic", {
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["read_file", "write_file"],
            requiredSourceArtifacts: ["tmp/BLUEPRINT.md"],
            targetArtifacts: ["tmp/game_logic.js", "tmp/index.html"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
      ],
      edges: [{ from: "generate_blueprint", to: "implement_game_logic" }],
    })

    let delegateCalls = 0
    const readFileTool: Tool = {
      name: "read_file",
      description: "read",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      async execute(args) {
        const path = String(args.path)
        if (path.endsWith("BLUEPRINT.md")) {
          return [
            "# Broken Blueprint",
            "",
            makeBlueprintContract(["game/rules.js", "game/index.html"]),
          ].join("\n")
        }
        return "Error: not found"
      },
    }

    const result = await executePipeline(
      plan,
      [readFileTool],
      async (step) => {
        delegateCalls += 1
        return {
          output: `done ${step.name}`,
          toolCalls: [
            { name: "write_file", args: { path: step.executionContext.targetArtifacts[0], content: "ok" }, result: "ok", isError: false },
            { name: "read_file", args: { path: "tmp/BLUEPRINT.md" }, result: "ok", isError: false },
          ],
        }
      },
      { workspaceRoot: "." },
    )

    expect(delegateCalls).toBe(2)
    expect(result.status).toBe("failed")
    expect(result.stepResults.get("generate_blueprint")?.failureClass).toBe("blueprint_contract")
    expect(result.stepResults.get("generate_blueprint")?.error).toContain("BLUEPRINT ARTIFACT COVERAGE FAILED")
    expect(result.stepResults.get("implement_game_logic")?.status).toBe("skipped")
  })

  it("fails blueprint steps when the machine-readable contract omits sharedTypes", async () => {
    const plan = makePlan({
      steps: [
        makeSubagentStep("generate_blueprint", {
          objective: "Create BLUEPRINT.md",
          acceptanceCriteria: ["Blueprint declares exact artifacts and shared types contract"],
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["read_file", "write_file"],
            requiredSourceArtifacts: [],
            targetArtifacts: ["tmp/BLUEPRINT.md"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
        makeSubagentStep("implement_game_logic", {
          executionContext: {
            workspaceRoot: ".",
            allowedReadRoots: ["."],
            allowedWriteRoots: ["."],
            allowedTools: ["read_file", "write_file"],
            requiredSourceArtifacts: ["tmp/BLUEPRINT.md"],
            targetArtifacts: ["tmp/game_logic.js"],
            effectClass: "filesystem_write",
            verificationMode: "none",
            artifactRelations: [],
          },
        }),
      ],
      edges: [{ from: "generate_blueprint", to: "implement_game_logic" }],
    })

    const readFileTool: Tool = {
      name: "read_file",
      description: "read",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      async execute(args) {
        const path = String(args.path)
        if (path.endsWith("BLUEPRINT.md")) {
          return [
            "# Incomplete Blueprint Contract",
            "",
            "```blueprint-contract",
            JSON.stringify({
              version: 1,
              files: [{ path: "tmp/game_logic.js", purpose: "Rules engine", functions: [] }],
            }, null, 2),
            "```",
          ].join("\n")
        }
        return "Error: not found"
      },
    }

    const result = await executePipeline(
      plan,
      [readFileTool],
      async (step) => ({
        output: `done ${step.name}`,
        toolCalls: [
          { name: "write_file", args: { path: step.executionContext.targetArtifacts[0], content: "ok" }, result: "ok", isError: false },
          { name: "read_file", args: { path: "tmp/BLUEPRINT.md" }, result: "ok", isError: false },
        ],
      }),
      { workspaceRoot: "." },
    )

    expect(result.status).toBe("failed")
    expect(result.stepResults.get("generate_blueprint")?.failureClass).toBe("blueprint_contract")
    expect(result.stepResults.get("generate_blueprint")?.error).toContain("sharedTypes")
    expect(result.stepResults.get("implement_game_logic")?.status).toBe("skipped")
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
