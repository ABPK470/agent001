/**
 * Planner answer synthesis — user-facing summary only.
 * Tool/SQL/step telemetry must never become the chat answer.
 */
import { describe, expect, it } from "vitest"
import { finalizePlannerRun } from "../src/core/plan/orchestrator/helpers.js"
import {
  isToolTelemetryDump,
  isUserFacingNarrative,
  synthesizeAnswer
} from "../src/core/plan/synthesize.js"
import type {
  DeterministicToolStep,
  PipelineResult,
  Plan,
  SubagentTaskStep,
  VerifierDecision
} from "../src/core/plan.js"

function makeDetStep(name: string, tool: string): DeterministicToolStep {
  return {
    name,
    stepType: "deterministic_tool",
    tool,
    args: {},
  }
}

function makeSubagent(name: string): SubagentTaskStep {
  return {
    name,
    stepType: "subagent_task",
    objective: `Do ${name}`,
    inputContract: "n/a",
    acceptanceCriteria: ["done"],
    requiredToolCapabilities: ["search_catalog"],
    contextRequirements: [],
    maxBudgetHint: "10",
    canRunParallel: true,
    executionContext: {
      workspaceRoot: ".",
      allowedReadRoots: ["."],
      allowedWriteRoots: ["."],
      allowedTools: ["search_catalog", "query_mssql", "write_file"],
      requiredSourceArtifacts: [],
      targetArtifacts: [],
      effectClass: "readonly",
      verificationMode: "none",
      artifactRelations: []
    }
  }
}

function passDecision(stepNames: string[]): VerifierDecision {
  return {
    overall: "pass",
    confidence: 0.9,
    steps: stepNames.map((stepName) => ({
      stepName,
      outcome: "pass",
      confidence: 0.9,
      issues: [],
      retryable: false
    })),
    unresolvedItems: []
  }
}

const SQL_DUMP = `(42 rows)
ClientId | Revenue | Product
---------|---------|--------
C1 | 100 | Widget
C2 | 200 | Gadget
${"C3 | 300 | Extra\n".repeat(40)}
If the user asked you to SAVE/EXPORT these rows to a file, do NOT copy this text into write_file — call export_query_to_file(...)`

describe("isToolTelemetryDump / isUserFacingNarrative", () => {
  it("flags SQL and pipe-table query results", () => {
    expect(isToolTelemetryDump(SQL_DUMP)).toBe(true)
    expect(isToolTelemetryDump("SELECT TOP 20 * FROM publish.Revenue")).toBe(true)
    expect(isUserFacingNarrative(SQL_DUMP)).toBe(false)
  })

  it("accepts short human answers", () => {
    const prose =
      "Revenue for the top clients is concentrated in publish.Revenue. " +
      "Adjust the client offer using Product dimension joins on ClientId."
    expect(isToolTelemetryDump(prose)).toBe(false)
    expect(isUserFacingNarrative(prose)).toBe(true)
  })
})

describe("synthesizeAnswer — success path never dumps tool telemetry", () => {
  it("uses the last subagent narrative and ignores deterministic SQL dumps", () => {
    const plan: Plan = {
      reason: "investigate revenue",
      confidence: 0.9,
      requiresSynthesis: true,
      steps: [
        makeDetStep("catalog_discovery", "search_catalog"),
        makeDetStep("revenue_schema", "explore_mssql_schema"),
        makeSubagent("analyze_revenue"),
        makeSubagent("write_answer")
      ],
      edges: []
    }

    const pipelineResult: PipelineResult = {
      status: "completed",
      completedSteps: 4,
      totalSteps: 4,
      stepResults: new Map([
        [
          "catalog_discovery",
          {
            name: "catalog_discovery",
            status: "completed",
            output: "tables: publish.Revenue, dim.Product",
            durationMs: 10
          }
        ],
        [
          "revenue_schema",
          {
            name: "revenue_schema",
            status: "completed",
            output: SQL_DUMP,
            durationMs: 20
          }
        ],
        [
          "analyze_revenue",
          {
            name: "analyze_revenue",
            status: "completed",
            output:
              "I inspected publish.Revenue and dim.Product. Grounding notes are in tmp/grounding.json.",
            durationMs: 100
          }
        ],
        [
          "write_answer",
          {
            name: "write_answer",
            status: "completed",
            output:
              "Adjusted client answer: focus the offer on top Product lines tied to ClientId in publish.Revenue. " +
              "See tmp/client_answer.md for the full write-up.",
            durationMs: 80
          }
        ]
      ])
    }

    const answer = synthesizeAnswer(
      plan,
      pipelineResult,
      passDecision(["catalog_discovery", "revenue_schema", "analyze_revenue", "write_answer"])
    )

    expect(answer).toContain("Adjusted client answer")
    expect(answer).not.toContain("SELECT")
    expect(answer).not.toContain("ClientId | Revenue")
    expect(answer).not.toContain("export_query_to_file")
    expect(answer.length).toBeLessThan(2_000)
  })

  it("does not join multiple SQL dumps when there is no narrative", () => {
    const plan: Plan = {
      reason: "schema probe",
      confidence: 0.9,
      requiresSynthesis: false,
      steps: [
        makeDetStep("a", "query_mssql"),
        makeDetStep("b", "query_mssql")
      ],
      edges: []
    }
    const pipelineResult: PipelineResult = {
      status: "completed",
      completedSteps: 2,
      totalSteps: 2,
      stepResults: new Map([
        [
          "a",
          { name: "a", status: "completed", output: SQL_DUMP, durationMs: 1, producedArtifacts: [] }
        ],
        [
          "b",
          {
            name: "b",
            status: "completed",
            output: SQL_DUMP.replace("42", "7"),
            durationMs: 1,
            producedArtifacts: ["tmp/notes.md"]
          }
        ]
      ])
    }

    const answer = synthesizeAnswer(plan, pipelineResult, passDecision(["a", "b"]))
    expect(answer).toBe("Created tmp/notes.md.")
    expect(answer).not.toContain("|")
  })

  it("keeps short multi-step codegen narratives when both are user-facing", () => {
    const plan: Plan = {
      reason: "build chess",
      confidence: 0.9,
      requiresSynthesis: false,
      steps: [makeSubagent("setup_board"), makeSubagent("add_rules")],
      edges: []
    }
    const pipelineResult: PipelineResult = {
      status: "completed",
      completedSteps: 2,
      totalSteps: 2,
      stepResults: new Map([
        [
          "setup_board",
          {
            name: "setup_board",
            status: "completed",
            output: "Done: created tmp/chess/index.html",
            durationMs: 1
          }
        ],
        [
          "add_rules",
          {
            name: "add_rules",
            status: "completed",
            output: "Verified in browser successfully.",
            durationMs: 1
          }
        ]
      ])
    }

    const answer = synthesizeAnswer(plan, pipelineResult, passDecision(["setup_board", "add_rules"]))
    // Short status lines may join; never tool dumps.
    expect(answer).toContain("created tmp/chess/index.html")
    expect(answer).toContain("Verified in browser successfully.")
    expect(answer).not.toMatch(/SELECT| \| /)
  })
})

describe("finalizePlannerRun — integration (check → answer)", () => {
  it("after Checked work (pass), answer is narrative not joined tool dumps", () => {
    const plan: Plan = {
      reason: "client offer grounding",
      confidence: 0.9,
      requiresSynthesis: true,
      steps: [
        makeDetStep("inspect_definition", "inspect_definition"),
        makeSubagent("analyze_revenue_grounding"),
        makeSubagent("write_adjusted_client_answer")
      ],
      edges: []
    }
    const pipelineResult: PipelineResult = {
      status: "completed",
      completedSteps: 3,
      totalSteps: 3,
      stepResults: new Map([
        [
          "inspect_definition",
          {
            name: "inspect_definition",
            status: "completed",
            output: "CREATE VIEW publish.Revenue AS\nSELECT ...\n" + "x".repeat(500),
            durationMs: 15
          }
        ],
        [
          "analyze_revenue_grounding",
          {
            name: "analyze_revenue_grounding",
            status: "completed",
            output: SQL_DUMP,
            durationMs: 200
          }
        ],
        [
          "write_adjusted_client_answer",
          {
            name: "write_adjusted_client_answer",
            status: "completed",
            output:
              "Here is the adjusted client answer based on the revenue grounding work. " +
              "Recommend packaging Product-tier offers for the top ClientId cohort.",
            durationMs: 120
          }
        ]
      ])
    }

    const result = finalizePlannerRun(
      plan,
      pipelineResult,
      passDecision([
        "inspect_definition",
        "analyze_revenue_grounding",
        "write_adjusted_client_answer"
      ])
    )

    expect(result.handled).toBe(true)
    expect(result.answer).toContain("adjusted client answer")
    expect(result.answer).not.toContain("CREATE VIEW")
    expect(result.answer).not.toContain("ClientId | Revenue")
    expect(result.answer!.length).toBeLessThan(1_000)
  })
})
