import { describe, expect, it } from "vitest"
import type { TraceEntry } from "../../types"
import {
  buildIterationHeader,
  buildResponseParts,
  buildToolNarrative,
  extractToolTarget,
  humanizeStepName,
} from "./build-chat-parts.js"

function llmRequest(iteration: number): TraceEntry {
  return {
    kind: "llm-request",
    iteration,
    messageCount: 1,
    toolCount: 1,
    messages: [{ role: "user", content: "go", toolCalls: [], toolCallId: null }],
  }
}

function llmResponse(
  iteration: number,
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [],
  content: string | null = null,
): TraceEntry {
  return {
    kind: "llm-response",
    iteration,
    durationMs: 50,
    content,
    toolCalls,
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  }
}

describe("extractToolTarget / narratives", () => {
  it("extracts path / command / query targets", () => {
    expect(
      extractToolTarget("write_file", JSON.stringify({ path: "site/index.html" }), ""),
    ).toMatch(/index\.html/)
    expect(
      extractToolTarget("run_command", JSON.stringify({ command: "npm run build" }), ""),
    ).toMatch(/npm/)
    expect(
      extractToolTarget("query_mssql", "", 'sql="select 1"'),
    ).toBeTruthy()
  })

  it("builds first-person narratives and iteration headers", () => {
    const tools = [
      { tool: "read_file", target: "a.ts" },
      { tool: "write_file", target: "b.ts" },
    ]
    expect(buildToolNarrative(tools)).toMatch(/^I /)
    expect(buildIterationHeader(tools).length).toBeGreaterThan(0)
    expect(humanizeStepName("frontend_layer")).toBe("frontend layer")
  })
})

describe("buildResponseParts — TermChat projection", () => {
  it("rolls tools into an iteration block and keeps results off the answer path", () => {
    const parts = buildResponseParts(
      [
        { kind: "iteration", current: 0, max: 10 },
        llmRequest(0),
        llmResponse(0, [{ id: "tc1", name: "write_file", arguments: { path: "a.html" } }]),
        {
          kind: "tool-call",
          invocationId: "inv1",
          toolCallId: "tc1",
          tool: "write_file",
          argsSummary: "a.html",
          argsFormatted: JSON.stringify({ path: "a.html" }),
        },
        {
          kind: "tool-result",
          invocationId: "inv1",
          toolCallId: "tc1",
          text: "ok",
        },
        { kind: "iteration", current: 1, max: 10 },
        llmRequest(1),
        llmResponse(1, [], "Done."),
      ],
      "completed",
      "",
      "Done.",
      null,
      null,
      "run-1",
    )

    expect(parts.some((p) => p.kind === "iteration-block")).toBe(true)
    expect(parts.some((p) => p.kind === "markdown")).toBe(true)
    const block = parts.find((p) => p.kind === "iteration-block")
    if (block?.kind === "iteration-block") {
      expect(block.tools.some((t) => t.row.tool === "write_file")).toBe(true)
      expect(block.tools[0]?.row.status).toBe("done")
      expect(block.tools[0]?.row.details).toBe("ok")
    }
  })

  it("strips polished failure markers from final answers", () => {
    const marker = "\u2063pfm:\u2063"
    const parts = buildResponseParts(
      [],
      "failed",
      "",
      `${marker}Could not finish.\nReference: run_9`,
      null,
      null,
      "run-9",
    )
    const md = parts.find((p) => p.kind === "markdown")
    expect(md?.kind).toBe("markdown")
    if (md?.kind === "markdown") {
      expect(md.text).not.toContain(marker)
    }
  })

  it("surfaces pending ask_user as an input part", () => {
    const parts = buildResponseParts(
      [],
      "running",
      "",
      null,
      null,
      { runId: "run-1", question: "Which color?", options: ["navy", "cream"] },
      "run-1",
    )
    expect(parts.some((p) => p.kind === "input")).toBe(true)
  })

  it("hides empty repair progress peers (work nests under repair steps)", () => {
    const parts = buildResponseParts(
      [
        {
          kind: "planner-repair-plan",
          attempt: 1,
          rerunOrder: ["frontend_layer"],
          tasks: [],
        },
        {
          kind: "planner-step-start",
          stepName: "frontend_layer",
          stepType: "subagent_task",
        },
        {
          kind: "tool-call",
          invocationId: "inv",
          toolCallId: "tc",
          tool: "write_file",
          argsSummary: "x",
          argsFormatted: JSON.stringify({ path: "x" }),
        },
        {
          kind: "tool-result",
          invocationId: "inv",
          toolCallId: "tc",
          text: "ok",
        },
        {
          kind: "planner-step-end",
          stepName: "frontend_layer",
          status: "pass",
          durationMs: 10,
        },
      ],
      "running",
      "",
      null,
      null,
      null,
      "run-1",
    )
    const bareRepair = parts.filter(
      (p) => p.kind === "progress" && p.id.startsWith("repair") && !p.detail,
    )
    expect(bareRepair).toHaveLength(0)
  })

  it("demotes verify/step gaps to settled neutral chrome (not Check failed / error)", () => {
    const parts = buildResponseParts(
      [
        {
          kind: "planner-step-start",
          stepName: "frontend_layer",
          stepType: "subagent_task",
        },
        {
          kind: "planner-step-end",
          stepName: "frontend_layer",
          status: "fail",
          error: "build failed — missing brand-tokens",
          durationMs: 1200,
        },
        {
          kind: "planner-verification",
          overall: "fail",
          confidence: 0.4,
          steps: [
            {
              stepName: "frontend_layer",
              outcome: "fail",
              issues: ["missing brand-tokens"],
            },
          ],
        },
      ],
      "running",
      "",
      null,
      null,
      null,
      "run-1",
    )

    const step = parts.find((p) => p.kind === "step-block")
    expect(step?.kind).toBe("step-block")
    if (step?.kind === "step-block") {
      expect(step.status).toBe("done")
      expect(step.detail).toContain("missing brand-tokens")
    }

    const check = parts.find(
      (p) => p.kind === "progress" && p.id.startsWith("verification-"),
    )
    expect(check?.kind).toBe("progress")
    if (check?.kind === "progress") {
      expect(check.label).toBe("Check · needs work")
      expect(check.status).toBe("done")
      expect(check.detail).toBe("frontend layer")
      expect(check.body).toContain("missing brand-tokens")
      expect(check.detail).not.toContain("missing brand-tokens")
      expect(check.label).not.toMatch(/failed/i)
    }
  })

  it("treats pipeline completed status as success (not needs work)", () => {
    const parts = buildResponseParts(
      [
        {
          kind: "planner-step-start",
          stepName: "catalog_discovery",
          stepType: "deterministic_tool",
        },
        {
          kind: "planner-step-end",
          stepName: "catalog_discovery",
          status: "completed",
          durationMs: 42,
        },
      ],
      "running",
      "",
      null,
      null,
      null,
      "run-1",
    )

    const step = parts.find((p) => p.kind === "step-block")
    expect(step?.kind).toBe("step-block")
    if (step?.kind === "step-block") {
      expect(step.status).toBe("done")
      expect(step.detail).not.toBe("needs work")
      expect(step.detail).toMatch(/42|ms|s/)
    }
  })

  it("nests deterministic tool I/O under the step (chevron + args/output)", () => {
    const parts = buildResponseParts(
      [
        {
          kind: "planner-step-start",
          stepName: "revenue_schema",
          stepType: "deterministic_tool",
        },
        {
          kind: "tool-call",
          invocationId: "inv-det-1",
          toolCallId: "det-revenue_schema-abc",
          tool: "explore_mssql_schema",
          argsSummary: "table=publish.Revenue",
          argsFormatted: JSON.stringify({ table: "publish.Revenue" }, null, 2),
          stepName: "revenue_schema",
        },
        {
          kind: "tool-result",
          invocationId: "inv-det-1",
          toolCallId: "det-revenue_schema-abc",
          text: "columns: Amount, ClientId, …",
        },
        {
          kind: "planner-step-end",
          stepName: "revenue_schema",
          status: "completed",
          durationMs: 4400,
        },
      ],
      "running",
      "",
      null,
      null,
      null,
      "run-1",
    )

    const step = parts.find((p) => p.kind === "step-block")
    expect(step?.kind).toBe("step-block")
    if (step?.kind === "step-block") {
      expect(step.tools).toHaveLength(1)
      expect(step.tools[0]?.row.tool).toBe("explore_mssql_schema")
      expect(step.tools[0]?.row.argsFormatted).toContain("publish.Revenue")
      expect(step.tools[0]?.row.details).toContain("columns")
      expect(step.tools[0]?.row.status).toBe("done")
      expect(step.detail).toMatch(/explore|schema|Revenue/i)
      expect(step.detail).toMatch(/4\.4|4400|s|ms/)
    }
  })

  it("keeps Check first line to the step name; issues stay in collapsed body", () => {
    const parts = buildResponseParts(
      [
        {
          kind: "planner-verification",
          overall: "fail",
          confidence: 0.4,
          steps: [
            {
              stepName: "catalog_and_schema_discovery",
              outcome: "fail",
              issues: ["Waiting on accepted upstream artifacts: tmp/BLUEPRINT.md"],
            },
            {
              stepName: "inspect_revenue_definition_and_dependencies",
              outcome: "fail",
              issues: [
                "Waiting on accepted upstream artifacts: tmp/client_offer_grounding/schema_discovery.json, tmp/BLUEPRINT.md",
              ],
            },
          ],
        },
      ],
      "running",
      "",
      null,
      null,
      null,
      "run-1",
    )

    const check = parts.find(
      (p) => p.kind === "progress" && p.id.startsWith("verification-"),
    )
    expect(check?.kind).toBe("progress")
    if (check?.kind === "progress") {
      expect(check.label).toBe("Check · needs work")
      expect(check.detail).toBe("catalog and schema discovery")
      expect(check.detail).not.toMatch(/Waiting|BLUEPRINT/i)
      expect(check.body).toContain("Waiting on accepted upstream artifacts: tmp/BLUEPRINT.md")
      expect(check.body).toContain("inspect revenue definition and dependencies")
    }
  })

  it("uses verbose plan progress, folds parallel mode into PlanBlock, no second Plan chip", () => {
    const parts = buildResponseParts(
      [
        { kind: "planning_preflight" },
        {
          kind: "planner-decision",
          shouldPlan: true,
          route: "planner",
          reason: "multi-step",
        },
        { kind: "planner-generating" },
        {
          kind: "planner-plan-generated",
          stepCount: 2,
          steps: [
            { name: "generate_blueprint", type: "subagent_task" },
            { name: "frontend_layer", type: "subagent_task" },
          ],
        },
        {
          kind: "planner-delegation-decision",
          shouldDelegate: true,
          executionMode: "parallel",
          reason: "independent",
        },
        {
          kind: "planner-step-start",
          stepName: "generate_blueprint",
          stepType: "subagent_task",
        },
      ],
      "running",
      "",
      null,
      null,
      null,
      "run-1",
    )

    const planProgress = parts.filter((p) => p.kind === "progress" && p.id === "plan")
    expect(planProgress).toHaveLength(0)

    const plan = parts.find((p) => p.kind === "plan")
    expect(plan?.kind).toBe("plan")
    if (plan?.kind === "plan") {
      expect(plan.stepCount).toBe(2)
      expect(plan.executionMode).toBe("parallel")
    }

    expect(parts.some((p) => p.kind === "progress" && p.detail === "Parallel subagents")).toBe(false)

    const step = parts.find((p) => p.kind === "step-block")
    expect(step?.kind).toBe("step-block")
    if (step?.kind === "step-block") {
      expect(step.title).toMatch(/blueprint/i)
      expect(step.subagent).toBe(true)
    }
  })

  it("labels generating plan verbosely before the outline exists", () => {
    const parts = buildResponseParts(
      [{ kind: "planner-generating" }],
      "planning",
      "",
      null,
      null,
      null,
      "run-1",
    )
    const plan = parts.find((p) => p.kind === "progress" && p.id === "plan")
    expect(plan?.kind).toBe("progress")
    if (plan?.kind === "progress") {
      expect(plan.label).toBe("Generating plan…")
      expect(plan.detail).toBeUndefined()
    }
  })

  it("nests parallel subagent tools by stepName (not last openStepId)", () => {
    const parts = buildResponseParts(
      [
        {
          kind: "planner-plan-generated",
          stepCount: 2,
          steps: [
            { name: "frontend_layer", type: "subagent_task" },
            { name: "api_layer", type: "subagent_task" },
          ],
        },
        {
          kind: "planner-delegation-decision",
          shouldDelegate: true,
          executionMode: "parallel",
          reason: "independent",
        },
        {
          kind: "planner-step-start",
          stepName: "frontend_layer",
          stepType: "subagent_task",
        },
        {
          kind: "planner-step-start",
          stepName: "api_layer",
          stepType: "subagent_task",
        },
        {
          kind: "planner-delegation-start",
          stepName: "frontend_layer",
          depth: 1,
          goal: "Build the UI",
          tools: ["write_file"],
        },
        {
          kind: "planner-delegation-start",
          stepName: "api_layer",
          depth: 1,
          goal: "Build the API",
          tools: ["write_file"],
        },
        {
          kind: "tool-call",
          invocationId: "inv-fe",
          tool: "write_file",
          argsSummary: "ui.tsx",
          argsFormatted: JSON.stringify({ path: "ui.tsx" }),
          stepName: "frontend_layer",
        },
        {
          kind: "tool-call",
          invocationId: "inv-api",
          tool: "write_file",
          argsSummary: "api.ts",
          argsFormatted: JSON.stringify({ path: "api.ts" }),
          stepName: "api_layer",
        },
        {
          kind: "planner-delegation-iteration",
          stepName: "frontend_layer",
          depth: 1,
          iteration: 1,
          maxIterations: 20,
          toolNames: ["write_file"],
          content: null,
        },
      ],
      "running",
      "",
      null,
      null,
      null,
      "run-1",
    )

    const steps = parts.filter((p) => p.kind === "step-block")
    expect(steps).toHaveLength(2)
    const fe = steps.find((p) => p.kind === "step-block" && p.title.includes("frontend"))
    const api = steps.find((p) => p.kind === "step-block" && p.title.includes("api"))
    expect(fe?.kind).toBe("step-block")
    expect(api?.kind).toBe("step-block")
    if (fe?.kind === "step-block" && api?.kind === "step-block") {
      expect(fe.tools.map((t) => t.id)).toEqual(["inv-fe"])
      expect(api.tools.map((t) => t.id)).toEqual(["inv-api"])
      expect(fe.hasRunning).toBe(true)
      expect(api.hasRunning).toBe(true)
      expect(fe.detail).toContain("write file")
    }
  })
})
