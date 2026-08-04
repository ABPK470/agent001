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
  stepName?: string,
): LlmRequest {
  return {
    kind: "llm-request",
    iteration,
    messageCount: messages.length,
    toolCount: 0,
    messages,
    ...(stepName ? { stepName } : {}),
  }
}

function llmResponse(
  iteration: number,
  opts: {
    content?: string | null
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
    durationMs?: number
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
    stepName?: string
  } = {},
): Extract<TraceEntry, { kind: "llm-response" }> {
  return {
    kind: "llm-response",
    iteration,
    durationMs: opts.durationMs ?? 100,
    content: opts.content ?? null,
    toolCalls: opts.toolCalls ?? [],
    usage: opts.usage ?? { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    ...(opts.stepName ? { stepName: opts.stepName } : {}),
  }
}

describe("buildTraceDag", () => {
  it("returns empty hasData for a blank Hi-style run with no debug entries", () => {
    const dag = buildTraceDag([])
    expect(dag.hasData).toBe(false)
    expect(dag.calls).toEqual([])
    expect(dag.preamble.systemPrompt).toBeNull()
    expect(dag.preamble.systemPrompts).toEqual([])
    expect(dag.preamble.tools).toEqual([])
  })

  it("collects every system-prompt entry into preamble.systemPrompts", () => {
    const dag = buildTraceDag([
      { kind: "system-prompt", text: "Core persona." },
      { kind: "system-prompt", text: "Workspace rules." },
      { kind: "system-prompt", text: "Tool policy." },
      llmRequest(0, [{ role: "user", content: "Hi", toolCalls: [], toolCallId: null }]),
      llmResponse(0, { content: "Hello", toolCalls: [] }),
    ])
    expect(dag.preamble.systemPrompt).toBe("Core persona.")
    expect(dag.preamble.systemPrompts).toEqual([
      "Core persona.",
      "Workspace rules.",
      "Tool policy.",
    ])
    const systems = dag.calls[0]!.messages.filter((m) => m.role === "system")
    expect(systems.map((m) => m.content)).toEqual([
      "Core persona.",
      "Workspace rules.",
      "Tool policy.",
    ])
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
    expect(dag.preamble.systemPrompts).toEqual(["You are Mia."])
    expect(dag.preamble.tools).toHaveLength(1)
    expect(dag.calls).toHaveLength(2)

    const c0 = dag.calls[0]!
    expect(c0.headline).toBe("query_mssql, ask_user")
    expect(c0.toolBranches.map((t) => t.name)).toEqual(["query_mssql", "ask_user"])
    expect(c0.askedUser).toBe(true)
    expect(c0.waiting).toBe(false)
    expect(c0.toolBranches[0]?.status).toBe("proposed")
    expect(c0.toolBranches[0]?.resultText).toBeUndefined()

    // Direct loop chronology: Call → Work → Call (not Call×N then Work×N).
    expect(dag.spine.map((e) => e.kind)).toEqual(["call", "work", "call"])
    const work = dag.spine[1]
    expect(work?.kind).toBe("work")
    if (work?.kind === "work") {
      expect(work.work.afterCallIndex).toBe(0)
      expect(work.work.tools[0]?.resultText).toBe("1")
      expect(work.work.tools[0]?.status).toBe("done")
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
    expect(dag.stats.totalCostUsd).toBeGreaterThan(0)
    expect(dag.calls[0]?.startOffsetMs).toBe(0)
    expect(dag.calls[1]?.startOffsetMs).toBe(200)
  })

  it("interleaves Call → Work on direct multi-tool loops (not Call batch then Work batch)", () => {
    const dag = buildTraceDag([
      {
        kind: "planner-decision",
        score: 1,
        shouldPlan: false,
        route: "direct",
        reason: "simple_dialogue",
      },
      llmRequest(0),
      llmResponse(0, {
        toolCalls: [{ id: "tc1", name: "list_directory", arguments: { path: "." } }],
      }),
      {
        kind: "tool-call",
        invocationId: "inv1",
        toolCallId: "tc1",
        tool: "list_directory",
        argsSummary: ".",
        argsFormatted: '{"path":"."}',
      },
      {
        kind: "tool-result",
        invocationId: "inv1",
        toolCallId: "tc1",
        text: "ok",
      },
      llmRequest(1),
      llmResponse(1, {
        toolCalls: [{ id: "tc2", name: "query_mssql", arguments: { sql: "select 1" } }],
      }),
      {
        kind: "tool-call",
        invocationId: "inv2",
        toolCallId: "tc2",
        tool: "query_mssql",
        argsSummary: "sql",
        argsFormatted: '{"sql":"select 1"}',
      },
      {
        kind: "tool-result",
        invocationId: "inv2",
        toolCallId: "tc2",
        text: "1",
      },
      llmRequest(2),
      llmResponse(2, {
        toolCalls: [{ id: "tc3", name: "export_query_to_file", arguments: { path: "out.csv" } }],
      }),
      {
        kind: "tool-call",
        invocationId: "inv3",
        toolCallId: "tc3",
        tool: "export_query_to_file",
        argsSummary: "out.csv",
        argsFormatted: '{"path":"out.csv"}',
      },
      {
        kind: "tool-result",
        invocationId: "inv3",
        toolCallId: "tc3",
        text: "wrote",
      },
      llmRequest(3),
      llmResponse(3, { content: "Done.", toolCalls: [] }),
    ])

    expect(dag.spine.filter((e) => e.kind === "phase")).toHaveLength(0)
    expect(dag.spine.map((e) => e.kind)).toEqual([
      "call",
      "work",
      "call",
      "work",
      "call",
      "work",
      "call",
    ])
    const works = dag.spine.filter((e) => e.kind === "work")
    expect(works.map((e) => (e.kind === "work" ? e.work.afterCallIndex : -1))).toEqual([0, 1, 2])
    expect(works.map((e) => (e.kind === "work" ? e.work.tools[0]?.name : null))).toEqual([
      "list_directory",
      "query_mssql",
      "export_query_to_file",
    ])
  })

  it("attaches sql quality to the matching call and Work card", () => {
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
      llmResponse(0, {
        content: "ok",
        toolCalls: [{ id: "tc1", name: "query_mssql", arguments: { sql: "select 1" } }],
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
      sql,
    ])
    expect(dag.calls[0]!.sqlQuality).toHaveLength(1)
    expect(dag.calls[0]!.sqlQuality[0]!.sqlPreview).toBe("select 1")
    expect(dag.calls[0]!.toolBranches[0]?.status).toBe("proposed")
    const work = dag.spine.find((e) => e.kind === "work")
    expect(work?.kind).toBe("work")
    if (work?.kind === "work") {
      expect(work.work.sqlQuality).toHaveLength(1)
      expect(work.work.tools[0]?.status).toBe("done")
    }
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

  it("keeps one Pipeline card and nests Calls under each Subagent", () => {
    const dag = buildTraceDag([
      {
        kind: "planner-pipeline-start",
        attempt: 1,
        maxRetries: 2,
      },
      { kind: "planner-step-start", stepName: "api_layer", stepType: "subagent_task" },
      llmRequest(0),
      llmResponse(0, {
        toolCalls: [{ id: "tc-a", name: "list_directory", arguments: { path: "." } }],
      }),
      {
        kind: "tool-call",
        invocationId: "inv-a",
        toolCallId: "tc-a",
        tool: "list_directory",
        argsSummary: ".",
        argsFormatted: '{"path":"."}',
      },
      {
        kind: "tool-result",
        invocationId: "inv-a",
        toolCallId: "tc-a",
        text: "ok",
      },
      {
        kind: "planner-step-end",
        stepName: "api_layer",
        status: "pass",
        durationMs: 100,
      },
      { kind: "planner-step-start", stepName: "frontend_layer", stepType: "subagent_task" },
      llmRequest(0),
      llmResponse(0, {
        toolCalls: [{ id: "tc-b", name: "write_file", arguments: { path: "a.html" } }],
      }),
      {
        kind: "tool-call",
        invocationId: "inv-b",
        toolCallId: "tc-b",
        tool: "write_file",
        argsSummary: "a.html",
        argsFormatted: '{"path":"a.html"}',
      },
      {
        kind: "tool-result",
        invocationId: "inv-b",
        toolCallId: "tc-b",
        text: "Wrote a.html",
      },
      {
        kind: "planner-step-end",
        stepName: "frontend_layer",
        status: "pass",
        durationMs: 200,
      },
      {
        kind: "planner-verification",
        overall: "fail",
        confidence: 0.91,
        steps: [],
      },
      {
        kind: "planner-verification-followup",
        requestedSteps: ["frontend_layer"],
        reasons: [{ stepName: "frontend_layer", confidence: 0.91, ambiguousIssues: [] }],
      },
      {
        kind: "planner-pipeline-end",
        status: "success",
        completedSteps: 2,
        totalSteps: 2,
      },
    ])

    const pipelinePhases = dag.spine.filter(
      (e) => e.kind === "phase" && e.phase.family === "pipeline",
    )
    expect(pipelinePhases).toHaveLength(1)
    if (pipelinePhases[0]?.kind !== "phase") throw new Error("expected pipeline")
    expect(pipelinePhases[0].phase.summary).toMatch(/success/i)

    // Steps nest under Pipeline (loop prose), not as spine peers.
    const nestedSteps = (pipelinePhases[0].phase.children ?? []).filter(
      (c) => c.kind === "phase" && c.phase.family.startsWith("step:"),
    )
    expect(nestedSteps).toHaveLength(2)
    for (const step of nestedSteps) {
      if (step.kind !== "phase") throw new Error("expected phase")
      expect(step.phase.children?.some((c) => c.kind === "call")).toBe(true)
      expect(step.phase.children?.some((c) => c.kind === "work")).toBe(true)
    }

    const verifyNested = (pipelinePhases[0].phase.children ?? []).filter(
      (c) => c.kind === "phase" && c.phase.family === "verify",
    )
    expect(verifyNested).toHaveLength(1)
    expect(dag.spine.some((e) => e.kind === "phase" && e.phase.family === "verify")).toBe(
      false,
    )

    // Calls/Work/Steps belong under Pipeline — not flat peers after success.
    expect(dag.spine.some((e) => e.kind === "call" || e.kind === "work")).toBe(false)
    expect(
      dag.spine.some((e) => e.kind === "phase" && e.phase.family.startsWith("step:")),
    ).toBe(false)
  })

  it("keeps parallel subagent Calls/tools apart when iterations collide", () => {
    const dag = buildTraceDag([
      { kind: "planner-pipeline-start", attempt: 1, maxRetries: 1 },
      { kind: "planner-step-start", stepName: "api_layer", stepType: "subagent_task" },
      { kind: "planner-step-start", stepName: "frontend_layer", stepType: "subagent_task" },
      llmRequest(0, [], "api_layer"),
      llmRequest(0, [], "frontend_layer"),
      llmResponse(0, {
        toolCalls: [{ id: "tc-a", name: "list_directory", arguments: { path: "." } }],
        stepName: "api_layer",
      }),
      llmResponse(0, {
        toolCalls: [{ id: "tc-b", name: "write_file", arguments: { path: "a.html" } }],
        stepName: "frontend_layer",
      }),
      {
        kind: "tool-call",
        invocationId: "inv-b",
        toolCallId: "tc-b",
        tool: "write_file",
        argsSummary: "a.html",
        argsFormatted: '{"path":"a.html"}',
        stepName: "frontend_layer",
      },
      {
        kind: "tool-call",
        invocationId: "inv-a",
        toolCallId: "tc-a",
        tool: "list_directory",
        argsSummary: ".",
        argsFormatted: '{"path":"."}',
        stepName: "api_layer",
      },
      {
        kind: "tool-result",
        invocationId: "inv-a",
        toolCallId: "tc-a",
        text: "ok",
        stepName: "api_layer",
      },
      {
        kind: "tool-result",
        invocationId: "inv-b",
        toolCallId: "tc-b",
        text: "Wrote a.html",
        stepName: "frontend_layer",
      },
      {
        kind: "planner-step-end",
        stepName: "api_layer",
        status: "pass",
        durationMs: 100,
      },
      {
        kind: "planner-step-end",
        stepName: "frontend_layer",
        status: "pass",
        durationMs: 200,
      },
      {
        kind: "planner-pipeline-end",
        status: "success",
        completedSteps: 2,
        totalSteps: 2,
      },
    ])

    expect(dag.calls).toHaveLength(2)
    expect(dag.calls.map((c) => c.stepName).sort()).toEqual(["api_layer", "frontend_layer"])
    expect(dag.calls.every((c) => c.callOrdinal === 0)).toBe(true)

    const pipeline = dag.spine.find((e) => e.kind === "phase" && e.phase.family === "pipeline")
    if (pipeline?.kind !== "phase") throw new Error("expected pipeline")
    const steps = (pipeline.phase.children ?? []).filter((c) => c.kind === "phase")
    expect(steps).toHaveLength(2)

    for (const step of steps) {
      if (step.kind !== "phase") throw new Error("expected step")
      const callChild = step.phase.children?.find((c) => c.kind === "call")
      const workChild = step.phase.children?.find((c) => c.kind === "work")
      if (callChild?.kind !== "call" || workChild?.kind !== "work") {
        throw new Error(`missing call/work under ${step.phase.family}`)
      }
      const call = dag.calls[callChild.callIndex]!
      expect(call.stepName).toBe(step.phase.family.slice("step:".length))
      expect(workChild.work.tools).toHaveLength(1)
      if (call.stepName === "api_layer") {
        expect(workChild.work.tools[0]!.name).toBe("list_directory")
      } else {
        expect(workChild.work.tools[0]!.name).toBe("write_file")
      }
    }
  })

  it("nests one Repairing card between failed and repaired step under Pipeline", () => {
    const dag = buildTraceDag([
      { kind: "planner-pipeline-start", attempt: 1, maxRetries: 2 },
      { kind: "planner-step-start", stepName: "frontend_layer", stepType: "subagent_task" },
      llmRequest(0, [], "frontend_layer"),
      llmResponse(0, {
        toolCalls: [{ id: "boom", name: "run_command", arguments: {} }],
        stepName: "frontend_layer",
      }),
      {
        kind: "tool-call",
        invocationId: "i-boom",
        toolCallId: "boom",
        tool: "run_command",
        argsSummary: "build",
        argsFormatted: "{}",
        stepName: "frontend_layer",
      },
      {
        kind: "tool-error",
        invocationId: "i-boom",
        toolCallId: "boom",
        text: "Module not found",
        stepName: "frontend_layer",
      },
      {
        kind: "planner-step-end",
        stepName: "frontend_layer",
        status: "fail",
        durationMs: 100,
        error: "build failed",
      },
      {
        kind: "planner-verification",
        overall: "fail",
        confidence: 0.9,
        steps: [{ stepName: "frontend_layer", outcome: "fail", issues: ["tokens"] }],
      },
      {
        kind: "planner-repair-plan",
        attempt: 1,
        rerunOrder: ["frontend_layer"],
        tasks: [
          {
            stepName: "frontend_layer",
            mode: "repair",
            ownedIssueCodes: ["BUILD_FAIL"],
            dependencyIssueCodes: [],
          },
        ],
      },
      {
        kind: "planner-retry",
        attempt: 2,
        reason: "repair_frontend_build",
        retrySteps: 1,
        skippedSteps: 0,
        rerunOrder: ["frontend_layer"],
      },
      { kind: "planner-pipeline-start", attempt: 2, maxRetries: 2 },
      { kind: "planner-step-start", stepName: "frontend_layer", stepType: "subagent_task" },
      llmRequest(1, [], "frontend_layer"),
      llmResponse(1, {
        toolCalls: [{ id: "ok", name: "run_command", arguments: {} }],
        stepName: "frontend_layer",
      }),
      {
        kind: "tool-call",
        invocationId: "i-ok",
        toolCallId: "ok",
        tool: "run_command",
        argsSummary: "build",
        argsFormatted: "{}",
        stepName: "frontend_layer",
      },
      {
        kind: "tool-result",
        invocationId: "i-ok",
        toolCallId: "ok",
        text: "Build succeeded",
        stepName: "frontend_layer",
      },
      {
        kind: "planner-step-end",
        stepName: "frontend_layer",
        status: "pass",
        durationMs: 80,
      },
      {
        kind: "planner-pipeline-end",
        status: "success",
        completedSteps: 1,
        totalSteps: 1,
      },
    ])

    expect(dag.spine.some((e) => e.kind === "phase" && e.phase.family === "repair")).toBe(false)
    expect(dag.spine.some((e) => e.kind === "phase" && e.phase.family === "verify")).toBe(false)

    const pipeline = dag.spine.find((e) => e.kind === "phase" && e.phase.family === "pipeline")
    if (pipeline?.kind !== "phase") throw new Error("expected pipeline")
    const kids = pipeline.phase.children ?? []
    const families = kids.map((c) => (c.kind === "phase" ? c.phase.family : c.kind))
    expect(families).toEqual([
      "step:frontend_layer",
      "verify",
      "repair",
      "step:frontend_layer",
    ])
    const repairs = kids.filter((c) => c.kind === "phase" && c.phase.family === "repair")
    expect(repairs).toHaveLength(1)
    if (repairs[0]?.kind !== "phase") throw new Error("expected repair")
    expect(repairs[0].phase.status).toBe("done")
    expect(repairs[0].phase.summary).toMatch(/repair_frontend_build/)
  })

  it("keeps failed step attempt red after repair pass (delegation-end must not rebind)", () => {
    const dag = buildTraceDag([
      { kind: "planner-pipeline-start", attempt: 1, maxRetries: 2 },
      { kind: "planner-step-start", stepName: "frontend_layer", stepType: "subagent_task" },
      llmRequest(0, [], "frontend_layer"),
      llmResponse(0, {
        toolCalls: [{ id: "boom", name: "run_command", arguments: { cmd: "npm run build" } }],
        stepName: "frontend_layer",
      }),
      {
        kind: "tool-call",
        invocationId: "i-boom",
        toolCallId: "boom",
        tool: "run_command",
        argsSummary: "npm run build",
        argsFormatted: "{}",
        stepName: "frontend_layer",
      },
      {
        kind: "tool-error",
        invocationId: "i-boom",
        toolCallId: "boom",
        text: "Module not found",
        stepName: "frontend_layer",
      },
      {
        kind: "planner-delegation-end",
        stepName: "frontend_layer",
        depth: 1,
        status: "error",
        error: "build failed",
      },
      {
        kind: "planner-step-end",
        stepName: "frontend_layer",
        status: "fail",
        durationMs: 100,
        error: "build failed",
      },
      { kind: "planner-pipeline-start", attempt: 2, maxRetries: 2 },
      { kind: "planner-step-start", stepName: "frontend_layer", stepType: "subagent_task" },
      llmRequest(1, [], "frontend_layer"),
      llmResponse(1, {
        toolCalls: [{ id: "ok", name: "run_command", arguments: { cmd: "npm run build" } }],
        stepName: "frontend_layer",
      }),
      {
        kind: "tool-call",
        invocationId: "i-ok",
        toolCallId: "ok",
        tool: "run_command",
        argsSummary: "npm run build",
        argsFormatted: "{}",
        stepName: "frontend_layer",
      },
      {
        kind: "tool-result",
        invocationId: "i-ok",
        toolCallId: "ok",
        text: "Build succeeded",
        stepName: "frontend_layer",
      },
      {
        kind: "planner-delegation-end",
        stepName: "frontend_layer",
        depth: 1,
        status: "done",
        answer: "Build green",
      },
      {
        kind: "planner-step-end",
        stepName: "frontend_layer",
        status: "pass",
        durationMs: 80,
      },
      {
        kind: "planner-pipeline-end",
        status: "success",
        completedSteps: 1,
        totalSteps: 1,
      },
    ])

    const pipeline = dag.spine.find((e) => e.kind === "phase" && e.phase.family === "pipeline")
    if (pipeline?.kind !== "phase") throw new Error("expected pipeline")
    const fronts = (pipeline.phase.children ?? []).filter(
      (c) => c.kind === "phase" && c.phase.family === "step:frontend_layer",
    )
    expect(fronts).toHaveLength(2)
    if (fronts[0]?.kind !== "phase" || fronts[1]?.kind !== "phase") {
      throw new Error("expected two frontend phases")
    }
    expect(fronts[0].phase.status).toBe("error")
    expect(fronts[0].phase.summary).toMatch(/fail/i)
    expect(fronts[1].phase.status).toBe("done")
    const failWork = fronts[0].phase.children?.find((c) => c.kind === "work")
    const okWork = fronts[1].phase.children?.find((c) => c.kind === "work")
    expect(failWork?.kind === "work" && failWork.work.tools.some((t) => t.status === "error")).toBe(
      true,
    )
    expect(okWork?.kind === "work" && okWork.work.tools.every((t) => t.status !== "error")).toBe(
      true,
    )
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

  it("keeps Received tools proposed (no results) and Work as execute+validate", () => {
    const dag = buildTraceDag([
      llmRequest(0),
      llmResponse(0, {
        content: null,
        toolCalls: [{ id: "tc1", name: "query_mssql", arguments: { sql: "select 1" } }],
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
      {
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
      },
    ])
    const call = dag.calls[0]!
    expect(call.toolBranches).toHaveLength(1)
    expect(call.toolBranches[0]?.status).toBe("proposed")
    expect(call.toolBranches[0]?.resultText).toBeUndefined()
    expect(call.sqlQuality[0]?.phase).toBe("executed")

    const work = dag.spine.find((e) => e.kind === "work")
    expect(work?.kind).toBe("work")
    if (work?.kind === "work") {
      expect(work.work.tools[0]?.status).toBe("done")
      expect(work.work.tools[0]?.resultText).toBe("1")
      expect(work.work.sqlQuality).toHaveLength(1)
      expect(work.work.sqlQuality[0]?.phase).toBe("executed")
    }
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
