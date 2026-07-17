import { EventType, OperationStatus } from "@mia/shared-enums"
import { beforeEach, describe, expect, it, vi } from "vitest"

const listEventsForRunId = vi.fn()
const getRun = vi.fn()

vi.mock("../src/infra/persistence/sqlite.js", () => ({
  listEventsForRunId,
  getRun
}))

function trace(kind: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ runId: "run-1", seq: 0, entry: { kind, ...extra } })
}

describe("agent-run pipeline telemetry grouping", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    getRun.mockReturnValue({
      status: "completed",
      completed_at: "2026-05-27T15:00:00.000Z",
      goal: "list top clients",
      step_count: 1,
      agent_id: "copilot",
      error: null
    })
  })

  it("collapses consecutive debug.trace events into one row in chronological position", async () => {
    listEventsForRunId.mockReturnValue([
      { type: EventType.RunStarted, created_at: "2026-05-27T14:55:00.000Z", data: JSON.stringify({ runId: "run-1", goal: "list top clients" }) },
      { type: EventType.DebugTrace, created_at: "2026-05-27T14:55:01.000Z", data: trace("iteration", { current: 1, max: 10 }) },
      { type: EventType.DebugTrace, created_at: "2026-05-27T14:55:02.000Z", data: trace("thinking", { text: "planning the query" }) },
      { type: EventType.DebugTrace, created_at: "2026-05-27T14:55:03.000Z", data: trace("llm-request", { iteration: 1, messageCount: 2, toolCount: 3 }) },
      { type: EventType.DebugTrace, created_at: "2026-05-27T14:55:04.000Z", data: trace("llm-response", { iteration: 1, durationMs: 1200, usage: { totalTokens: 800 } }) },
      { type: EventType.DebugTrace, created_at: "2026-05-27T14:55:05.000Z", data: trace("usage", { totalTokens: 800, iterationTokens: 800, llmCalls: 1 }) },
      { type: EventType.StepStarted, created_at: "2026-05-27T14:55:06.000Z", data: JSON.stringify({ runId: "run-1", action: "query_mssql" }) },
      { type: EventType.StepCompleted, created_at: "2026-05-27T14:55:07.000Z", data: JSON.stringify({ runId: "run-1", durationMs: 1000 }) },
      { type: EventType.CheckpointSaved, created_at: "2026-05-27T14:55:08.000Z", data: JSON.stringify({ runId: "run-1", iteration: 1, stepCounter: 1 }) },
      { type: EventType.RunCompleted, created_at: "2026-05-27T14:55:09.000Z", data: JSON.stringify({ runId: "run-1" }) }
    ])

    const { listOperationsForRun } = await import("../src/api/operations/service/query/index.ts")
    const { operation } = listOperationsForRun("run-1")

    expect(operation).not.toBeNull()
    // Chronological order: the debug-trace burst sits BETWEEN "started" and the
    // tool step (where it actually happened), and the checkpoint sits between the
    // step and "completed". Nothing is dumped at the end.
    expect(operation!.activities.map((a) => a.name)).toEqual([
      "started",
      "Debug trace",
      "query_mssql",
      "Checkpoint",
      "completed"
    ])

    // Exactly ONE "Debug trace" row (not one per debug.trace event)…
    expect(operation!.activities.filter((a) => a.name === "Debug trace").length).toBe(1)
    const debugTrace = operation!.activities.find((a) => a.name === "Debug trace")!
    expect(debugTrace.events.length).toBe(5)
    expect(debugTrace.status).toBe(OperationStatus.Success)
    // Summary surfaces the distinct kinds so the operator sees what's inside
    // before expanding.
    expect(debugTrace.summary).toContain("5 entries")
    expect(debugTrace.summary).toContain("iteration")
    expect(debugTrace.summary).toContain("thinking")
  })

  it("emits a fresh Debug trace row per iteration burst (not one giant row for the whole run)", async () => {
    listEventsForRunId.mockReturnValue([
      { type: EventType.RunStarted, created_at: "2026-05-27T14:55:00.000Z", data: JSON.stringify({ runId: "run-1", goal: "g" }) },
      { type: EventType.DebugTrace, created_at: "2026-05-27T14:55:01.000Z", data: trace("iteration", { current: 1, max: 5 }) },
      { type: EventType.DebugTrace, created_at: "2026-05-27T14:55:02.000Z", data: trace("thinking", { text: "t1" }) },
      { type: EventType.StepStarted, created_at: "2026-05-27T14:55:03.000Z", data: JSON.stringify({ runId: "run-1", action: "search_catalog" }) },
      { type: EventType.StepCompleted, created_at: "2026-05-27T14:55:04.000Z", data: JSON.stringify({ runId: "run-1", durationMs: 500 }) },
      { type: EventType.DebugTrace, created_at: "2026-05-27T14:55:05.000Z", data: trace("iteration", { current: 2, max: 5 }) },
      { type: EventType.DebugTrace, created_at: "2026-05-27T14:55:06.000Z", data: trace("thinking", { text: "t2" }) },
      { type: EventType.RunCompleted, created_at: "2026-05-27T14:55:07.000Z", data: JSON.stringify({ runId: "run-1" }) }
    ])

    const { listOperationsForRun } = await import("../src/api/operations/service/query/index.ts")
    const { operation } = listOperationsForRun("run-1")

    // The step between the two bursts closes the first group, so each iteration
    // gets its own "Debug trace" row in chronological position.
    expect(operation!.activities.map((a) => a.name)).toEqual([
      "started",
      "Debug trace",
      "search_catalog",
      "Debug trace",
      "completed"
    ])
    const bursts = operation!.activities.filter((a) => a.name === "Debug trace")
    expect(bursts.length).toBe(2)
    expect(bursts[0]!.events.length).toBe(2)
    expect(bursts[1]!.events.length).toBe(2)
  })

  it("folds tool_call.* kill-signals into their step row so every tool is a step row (incl. ask_user)", async () => {
    listEventsForRunId.mockReturnValue([
      { type: EventType.RunStarted, created_at: "2026-05-27T14:55:00.000Z", data: JSON.stringify({ runId: "run-1", goal: "g" }) },
      { type: EventType.DebugTrace, created_at: "2026-05-27T14:55:01.000Z", data: trace("iteration", { current: 1, max: 5 }) },
      { type: EventType.StepStarted, created_at: "2026-05-27T14:55:02.000Z", data: JSON.stringify({ runId: "run-1", action: "ask_user" }) },
      { type: EventType.ToolCallExecuting, created_at: "2026-05-27T14:55:02.500Z", data: JSON.stringify({ runId: "run-1", toolCallId: "tc-1", toolName: "ask_user" }) },
      { type: EventType.ToolCallCompleted, created_at: "2026-05-27T14:55:03.000Z", data: JSON.stringify({ runId: "run-1", toolCallId: "tc-1" }) },
      { type: EventType.StepCompleted, created_at: "2026-05-27T14:55:03.500Z", data: JSON.stringify({ runId: "run-1", durationMs: 1500 }) },
      { type: EventType.RunCompleted, created_at: "2026-05-27T14:55:04.000Z", data: JSON.stringify({ runId: "run-1" }) }
    ])

    const { listOperationsForRun } = await import("../src/api/operations/service/query/index.ts")
    const { operation } = listOperationsForRun("run-1")
    const names = operation!.activities.map((a) => a.name)

    // ask_user is a step row exactly like any other tool; the tool_call.* signals
    // fold into it and never surface as a separate "Tool call" telemetry row.
    expect(names).toEqual(["started", "Debug trace", "ask_user", "completed"])
    expect(names.filter((n) => n === "Tool call").length).toBe(0)
    const askUser = operation!.activities.find((a) => a.name === "ask_user")!
    // The kill-signals are retained as expandable detail under the step.
    expect(askUser.events.some((e) => e.type === EventType.ToolCallExecuting)).toBe(true)
    expect(askUser.events.some((e) => e.type === EventType.ToolCallCompleted)).toBe(true)
  })

  it("marks a telemetry group failed when any entry carries an error", async () => {
    listEventsForRunId.mockReturnValue([
      { type: EventType.RunStarted, created_at: "2026-05-27T14:55:00.000Z", data: JSON.stringify({ runId: "run-1", goal: "g" }) },
      { type: EventType.DebugTrace, created_at: "2026-05-27T14:55:01.000Z", data: trace("iteration", { current: 1, max: 5 }) },
      { type: EventType.DebugTrace, created_at: "2026-05-27T14:55:02.000Z", data: trace("error", { text: "boom" }) },
      { type: EventType.RunFailed, created_at: "2026-05-27T14:55:03.000Z", data: JSON.stringify({ runId: "run-1", error: "boom" }) }
    ])

    const { listOperationsForRun } = await import("../src/api/operations/service/query/index.ts")
    const { operation } = listOperationsForRun("run-1")
    expect(operation!.activities.map((a) => a.name)).toEqual(["started", "Debug trace", "failed"])
    const debugTrace = operation!.activities.find((a) => a.name === "Debug trace")!
    expect(debugTrace.status).toBe(OperationStatus.Failed)
  })
})
