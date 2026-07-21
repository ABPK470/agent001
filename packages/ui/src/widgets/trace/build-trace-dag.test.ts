import { describe, expect, it } from "vitest"
import type { TraceEntry } from "../../types"
import {
  buildTraceDag,
  historyRowLabel,
  replyHeadline,
  searchCall,
} from "./build-trace-dag.js"

type LlmRequest = Extract<TraceEntry, { kind: "llm-request" }>

function llmRequest(
  iteration: number,
  messages: LlmRequest["messages"] = [],
): LlmRequest {
  return {
    kind: "llm-request",
    iteration,
    messageCount: messages.length,
    toolCount: 0,
    messages,
  }
}

function llmResponse(
  iteration: number,
  opts: {
    content?: string | null
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
    durationMs?: number
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  } = {},
): Extract<TraceEntry, { kind: "llm-response" }> {
  return {
    kind: "llm-response",
    iteration,
    durationMs: opts.durationMs ?? 100,
    content: opts.content ?? null,
    toolCalls: opts.toolCalls ?? [],
    usage: opts.usage ?? { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  }
}

describe("buildTraceDag", () => {
  it("returns empty hasData for a blank Hi-style run with no debug entries", () => {
    const dag = buildTraceDag([])
    expect(dag.hasData).toBe(false)
    expect(dag.calls).toEqual([])
    expect(dag.preamble.systemPrompt).toBeNull()
    expect(dag.preamble.tools).toEqual([])
  })

  it("pairs request/response by iteration and builds tool branches", () => {
    const dag = buildTraceDag([
      { kind: "system-prompt", text: "You are Mia." },
      {
        kind: "tools-resolved",
        tools: [{ name: "query_mssql", description: "Run SQL" }],
      },
      llmRequest(0, [
        { role: "user", content: "Hi", toolCalls: [], toolCallId: null },
      ]),
      llmResponse(0, {
        content: null,
        toolCalls: [
          { id: "tc1", name: "query_mssql", arguments: { sql: "select 1" } },
          { id: "tc2", name: "ask_user", arguments: { question: "ok?" } },
        ],
        durationMs: 200,
        usage: { promptTokens: 40, completionTokens: 12, totalTokens: 52 },
      }),
      {
        kind: "tool-call",
        invocationId: "inv1",
        toolCallId: "tc1",
        tool: "query_mssql",
        argsSummary: "sql",
        argsFormatted: '{"sql":"select 1"}',
      },
      {
        kind: "tool-result",
        invocationId: "inv1",
        toolCallId: "tc1",
        text: "1",
      },
      llmRequest(1, [
        { role: "user", content: "Hi", toolCalls: [], toolCallId: null },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "tc2", name: "ask_user", arguments: {} }],
          toolCallId: null,
        },
        {
          role: "tool",
          content: "yes",
          toolCalls: [],
          toolCallId: "tc2",
        },
      ]),
      llmResponse(1, {
        content: "Hello!",
        toolCalls: [],
        durationMs: 50,
        usage: { promptTokens: 60, completionTokens: 8, totalTokens: 68 },
      }),
    ])

    expect(dag.hasData).toBe(true)
    expect(dag.preamble.systemPrompt).toBe("You are Mia.")
    expect(dag.preamble.tools).toHaveLength(1)
    expect(dag.calls).toHaveLength(2)

    const c0 = dag.calls[0]!
    expect(c0.headline).toBe("query_mssql, ask_user")
    expect(c0.toolBranches.map((t) => t.name)).toEqual(["query_mssql", "ask_user"])
    expect(c0.askedUser).toBe(true)
    expect(c0.waiting).toBe(false)
    expect(c0.toolBranches[0]?.status).toBe("done")
    expect(c0.toolBranches[0]?.resultText).toBe("1")

    const work = dag.spine.find((e) => e.kind === "work")
    expect(work?.kind).toBe("work")
    if (work?.kind === "work") {
      expect(work.work.tools[0]?.resultText).toBe("1")
    }
    expect(dag.stats.toolRunCount).toBe(1)

    const c1 = dag.calls[1]!
    expect(c1.headline).toBe("Final answer")
    expect(c1.content).toBe("Hello!")
    expect(c1.messages[0]?.speaker).toBe("System")
    expect(c1.messages.map((m) => m.speaker)).toContain("User answer")
    expect(c1.messages.find((m) => m.speaker === "User answer")?.content).toBe("yes")

    expect(dag.stats.callCount).toBe(2)
    expect(dag.stats.promptTokens).toBe(100)
    expect(dag.stats.completionTokens).toBe(20)
    expect(dag.stats.totalDuration).toBe(250)
  })

  it("attaches sql quality to the matching call (not context preamble)", () => {
    const sql: Extract<TraceEntry, { kind: "planner-sql-quality" }> = {
      kind: "planner-sql-quality",
      toolCallId: "tc1",
      toolName: "query_mssql",
      iteration: 0,
      toolMode: "query",
      phase: "executed",
      connection: "main",
      database: "db",
      validationOk: true,
      validationCode: null,
      largeObjectRefs: [],
      usesPersistedMirrors: [],
      missingPersistedMirrorCandidates: [],
      hasWhereClause: true,
      unsafeScanReason: null,
      tempTableRefs: 0,
      tempTablesCreated: 0,
      tempTableSuffixes: [],
      malformedTempSuffixes: [],
      missingTempCreations: [],
      aggregateWarningCount: 0,
      aggregateBlockCount: 0,
      tempScalarSubqueryCount: 0,
      stagePatternLikely: false,
      durationMs: 12,
      rowCount: 1,
      error: null,
      sqlPreview: "select 1",
      sqlLength: 8,
    }
    const dag = buildTraceDag([
      llmRequest(0),
      llmResponse(0, { content: "ok" }),
      sql,
    ])
    expect(dag.calls[0]!.sqlQuality).toHaveLength(1)
    expect(dag.calls[0]!.sqlQuality[0]!.sqlPreview).toBe("select 1")
  })

  it("marks waiting when response is missing", () => {
    const dag = buildTraceDag([llmRequest(0)])
    expect(dag.calls[0]!.waiting).toBe(true)
    expect(dag.calls[0]!.headline).toBe("Waiting…")
  })

  it("merges consecutive plan events into one expandable phase", () => {
    const dag = buildTraceDag([
      {
        kind: "planner-decision",
        score: 4,
        shouldPlan: true,
        route: "planner",
        reason: "multi_step+implementation_scope",
      },
      {
        kind: "planner-plan-generated",
        reason: "multi_step+implementation_scope",
        stepCount: 3,
        steps: [
          { name: "schema_contract", type: "subagent_task" },
          { name: "api_endpoints", type: "subagent_task", dependsOn: ["schema_contract"] },
          { name: "frontend_pages", type: "subagent_task", dependsOn: ["api_endpoints"] },
        ],
      },
    ])
    const phases = dag.spine.filter((e) => e.kind === "phase")
    expect(phases).toHaveLength(1)
    if (phases[0]?.kind !== "phase") throw new Error("expected phase")
    const plan = phases[0].phase
    expect(plan.family).toBe("plan")
    expect(plan.title).toBe("Plan")
    expect(plan.summary).toMatch(/3 steps/)
    expect(plan.details.length).toBeGreaterThan(0)
    expect(plan.details.some((d) => d.kind === "json" && d.label === "Plan graph")).toBe(true)
    expect(plan.details.filter((d) => d.kind === "step")).toHaveLength(3)
  })

  it("merges one step’s lifecycle into a single phase until family changes", () => {
    const dag = buildTraceDag([
      { kind: "planner-step-start", stepName: "frontend_layer", stepType: "subagent_task" },
      {
        kind: "planner-delegation-start",
        goal: "Build frontend",
        stepName: "frontend_layer",
        depth: 1,
        tools: ["write_file", "run_command"],
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
        envelope: { targetArtifacts: ["site/index.html"] },
      },
      {
        kind: "planner-delegation-end",
        stepName: "frontend_layer",
        depth: 1,
        status: "done",
        answer: "ok",
      },
      {
        kind: "planner-step-end",
        stepName: "frontend_layer",
        status: "pass",
        durationMs: 900,
        producedArtifacts: ["site/index.html"],
      },
      {
        kind: "planner-verification",
        overall: "pass",
        confidence: 0.9,
        steps: [{ stepName: "frontend_layer", outcome: "pass", issues: [] }],
      },
    ])
    const phases = dag.spine.filter((e) => e.kind === "phase")
    expect(phases.map((e) => (e.kind === "phase" ? e.phase.family : ""))).toEqual([
      "step:frontend_layer",
      "verify",
    ])
    const step = phases[0]
    if (step?.kind !== "phase") throw new Error("expected step phase")
    expect(step.phase.leading).toBe("Subagent")
    expect(step.phase.title).toBe("frontend layer")
    expect(step.phase.summary).toBe("done")
    expect(step.phase.details.some((d) => d.kind === "event" && d.text.includes("Artifacts"))).toBe(
      true,
    )
  })

  it("nests Call and Work under an open subagent step phase", () => {
    const dag = buildTraceDag([
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
        envelope: { targetArtifacts: ["site/index.html"] },
      },
      llmRequest(0),
      llmResponse(0, {
        toolCalls: [{ id: "tc-w", name: "write_file", arguments: { path: "a.html" } }],
      }),
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
    ])
    const spineKinds = dag.spine.map((e) => e.kind)
    expect(spineKinds).toEqual(["phase"])
    const phase = dag.spine[0]
    if (phase?.kind !== "phase") throw new Error("expected phase")
    expect(phase.phase.leading).toBe("Subagent")
    expect(phase.phase.children?.map((c) => c.kind)).toEqual(["call", "work"])
    expect(dag.stats.toolRunCount).toBe(1)
    // Call/Work are not flat peers of the step.
    expect(dag.spine.some((e) => e.kind === "call" || e.kind === "work")).toBe(false)
  })

  it("omits Direct chips with nothing to expand", () => {
    const dag = buildTraceDag([
      {
        kind: "planner-decision",
        score: 1,
        shouldPlan: false,
        route: "direct",
        reason: "simple_dialogue",
      },
    ])
    expect(dag.spine.filter((e) => e.kind === "phase")).toHaveLength(0)
  })

  it("injects System into Sent when llm-request omitted it", () => {
    const dag = buildTraceDag([
      { kind: "system-prompt", text: "You are Mia." },
      llmRequest(0, [{ role: "user", content: "Hi", toolCalls: [], toolCallId: null }]),
      llmResponse(0, { content: "Hello" }),
    ])
    expect(dag.calls[0]!.messages[0]?.speaker).toBe("System")
    expect(dag.calls[0]!.messages[0]?.content).toBe("You are Mia.")
    expect(dag.calls[0]!.messages[1]?.speaker).toBe("User")
  })
})

describe("replyHeadline", () => {
  it("summarizes tool names", () => {
    expect(
      replyHeadline(
        llmResponse(0, {
          toolCalls: [
            { id: "a", name: "a", arguments: {} },
            { id: "b", name: "b", arguments: {} },
            { id: "c", name: "c", arguments: {} },
          ],
        }),
      ),
    ).toBe("a, b +1")
  })
})

describe("historyRowLabel", () => {
  it("labels ask_user tool results as User answer", () => {
    const messages = [
      {
        role: "assistant",
        toolCallId: null as string | null,
        toolCalls: [{ id: "x", name: "ask_user", arguments: {} }],
      },
      {
        role: "tool",
        toolCallId: "x" as string | null,
        toolCalls: [] as Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
      },
    ]
    expect(historyRowLabel(messages[1]!, messages, 1)).toEqual({
      speaker: "User answer",
      detail: "via ask_user",
    })
  })
})

describe("searchCall", () => {
  it("matches tool name in reply branches", () => {
    const dag = buildTraceDag([
      llmRequest(0),
      llmResponse(0, {
        toolCalls: [{ id: "tc1", name: "query_mssql", arguments: {} }],
      }),
    ])
    const hit = searchCall(dag.calls[0]!, "query_mssql")
    expect(hit?.inReply).toBe(true)
    expect(hit?.reasons[0]).toContain("tool")
  })
})
