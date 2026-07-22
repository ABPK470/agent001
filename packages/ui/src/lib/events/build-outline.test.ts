import { describe, expect, it } from "vitest"
import type { TraceEntry } from "@mia/shared-types"
import { atomsFromTrace, buildOutline, TRACE_VIEW_SPEC } from "./index"

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
): TraceEntry {
  return {
    kind: "llm-response",
    iteration,
    durationMs: 100,
    content: null,
    toolCalls,
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  }
}

describe("buildOutline", () => {
  it("nests Call and Work under an open subagent step", () => {
    const trace: TraceEntry[] = [
      { kind: "planner-step-start", stepName: "frontend_layer", stepType: "subagent_task" },
      {
        kind: "planner-delegation-start",
        goal: "Build frontend",
        stepName: "frontend_layer",
        depth: 1,
        tools: ["write_file"],
        budget: {
          hint: "medium",
          parsedHint: 8,
          baseBudget: 8,
          contractFloor: 4,
          complexityBoost: 0,
          computedMaxIterations: 10,
          targetArtifactCount: 1,
          requiredSourceArtifactCount: 0,
          acceptanceCriteriaCount: 0,
          codeArtifactCount: 1,
          hasComplexImplementation: false,
          hasBlueprintSource: false,
          verificationMode: "run_tests",
        },
        envelope: {},
      },
      llmRequest(0),
      llmResponse(0, [{ id: "tc-w", name: "write_file", arguments: { path: "a.html" } }]),
      {
        kind: "tool-call",
        invocationId: "inv-w",
        toolCallId: "tc-w",
        tool: "write_file",
        argsSummary: "a.html",
        argsFormatted: JSON.stringify({ path: "a.html" }),
      },
      {
        kind: "tool-result",
        invocationId: "inv-w",
        toolCallId: "tc-w",
        text: "Wrote a.html",
      },
      {
        kind: "planner-step-end",
        stepName: "frontend_layer",
        status: "pass",
        durationMs: 400,
      },
    ]

    const outline = buildOutline(atomsFromTrace(trace), TRACE_VIEW_SPEC)
    expect(outline).toHaveLength(1)
    expect(outline[0]!.family).toBe("step")
    expect(outline[0]!.label).toBe("Subagent")
    expect(outline[0]!.title).toBe("frontend layer")
    const families = (outline[0]!.children ?? []).map((c) => c.family)
    expect(families).toContain("call")
    expect(families).toContain("work")
  })

  it("merges plan events into one scope", () => {
    const trace: TraceEntry[] = [
      {
        kind: "planner-decision",
        score: 4,
        shouldPlan: true,
        route: "planner",
        reason: "multi_step",
      },
      {
        kind: "planner-plan-generated",
        reason: "multi_step",
        stepCount: 2,
        steps: [
          { name: "a", type: "subagent_task" },
          { name: "b", type: "subagent_task" },
        ],
      },
    ]
    const outline = buildOutline(atomsFromTrace(trace), TRACE_VIEW_SPEC)
    expect(outline).toHaveLength(1)
    expect(outline[0]!.family).toBe("plan")
    expect(outline[0]!.summary).toMatch(/2 steps/)
    expect(outline[0]!.atomIds.length).toBe(2)
  })

  it("merges pipeline start/end into one scope (no duplicate attempt card)", () => {
    const trace: TraceEntry[] = [
      { kind: "planner-pipeline-start", attempt: 1, maxRetries: 2 },
      { kind: "planner-step-start", stepName: "api_layer", stepType: "subagent_task" },
      llmRequest(0),
      llmResponse(0),
      { kind: "planner-step-end", stepName: "api_layer", status: "pass", durationMs: 10 },
      {
        kind: "planner-pipeline-end",
        status: "success",
        completedSteps: 1,
        totalSteps: 1,
      },
    ]
    const outline = buildOutline(atomsFromTrace(trace), TRACE_VIEW_SPEC)
    const pipelines = outline.filter((n) => n.family === "pipeline")
    expect(pipelines).toHaveLength(1)
    expect(pipelines[0]!.summary).toMatch(/success/i)
  })

  it("gives each subagent its own Call:0 (no cross-step merge)", () => {
    const trace: TraceEntry[] = [
      { kind: "planner-step-start", stepName: "api_layer", stepType: "subagent_task" },
      llmRequest(0),
      llmResponse(0),
      { kind: "planner-step-end", stepName: "api_layer", status: "pass", durationMs: 10 },
      { kind: "planner-step-start", stepName: "frontend_layer", stepType: "subagent_task" },
      llmRequest(0),
      llmResponse(0),
      { kind: "planner-step-end", stepName: "frontend_layer", status: "pass", durationMs: 10 },
    ]
    const outline = buildOutline(atomsFromTrace(trace), TRACE_VIEW_SPEC)
    expect(outline).toHaveLength(2)
    for (const step of outline) {
      expect(step.family).toBe("step")
      expect((step.children ?? []).some((c) => c.family === "call")).toBe(true)
      const call = (step.children ?? []).find((c) => c.family === "call")
      expect(call?.nestKey).toContain(step.nestKey!)
    }
  })
})
