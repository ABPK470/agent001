import { EventType, OperationKind, OperationStatus } from "@mia/shared-enums"
import { beforeEach, describe, expect, it, vi } from "vitest"

const listEvents = vi.fn()
const getRun = vi.fn()
const getSyncRun = vi.fn()

vi.mock("../src/adapters/persistence/sqlite.js", () => ({
  listEvents,
  getRun,
  getSyncRun,
}))

describe("listOperations sync bucketing", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it("keeps preview and execute as separate sync pipelines even when events carry runId", async () => {
    listEvents.mockReturnValue([
      {
        type: EventType.SyncAgentExecuteCompleted,
        created_at: "2026-05-27T14:56:38.000Z",
        data: JSON.stringify({ runId: "run-1", planId: "plan-1", success: true }),
      },
      {
        type: EventType.SyncExecuteCompleted,
        created_at: "2026-05-27T14:56:37.000Z",
        data: JSON.stringify({ runId: "run-1", planId: "plan-1", applied: { insert: 0, update: 2, delete: 0 } }),
      },
      {
        type: EventType.SyncExecuteStep,
        created_at: "2026-05-27T14:56:34.000Z",
        data: JSON.stringify({ runId: "run-1", planId: "plan-1", step: "deploy-etl" }),
      },
      {
        type: EventType.SyncExecuteStarted,
        created_at: "2026-05-27T14:56:33.000Z",
        data: JSON.stringify({ runId: "run-1", planId: "plan-1", source: "dev", target: "uat" }),
      },
      {
        type: EventType.SyncAgentExecuteStarted,
        created_at: "2026-05-27T14:56:32.000Z",
        data: JSON.stringify({ runId: "run-1", planId: "plan-1" }),
      },
      {
        type: EventType.SyncPreviewCompleted,
        created_at: "2026-05-27T14:55:06.000Z",
        data: JSON.stringify({ runId: "run-1", planId: "plan-1", totals: { insert: 0, update: 2, delete: 0 } }),
      },
      {
        type: EventType.RunStarted,
        created_at: "2026-05-27T14:54:59.000Z",
        data: JSON.stringify({ runId: "run-1", goal: "run sync" }),
      },
    ])

    getRun.mockReturnValue({
      status: "running",
      completed_at: null,
      goal: "run sync",
      step_count: 1,
      agent_id: "copilot",
      error: null,
    })

    getSyncRun.mockReturnValue({
      status: "success",
      finished_at: "2026-05-27T14:56:38.000Z",
      duration_ms: 6000,
      entity_display_name: "AccountClientMapping",
      entity_type: "contract",
      entity_id: "4539",
      source: "dev",
      target: "uat",
      error: null,
    })

    const { listOperations } = await import("../src/api/operations-query.ts")
    const result = listOperations({ limit: 50 })

    expect(result.operations).toHaveLength(3)
    expect(result.operations.map((op) => op.kind)).toEqual([
      OperationKind.SyncExecute,
      OperationKind.SyncPreview,
      OperationKind.AgentRun,
    ])

    const execute = result.operations.find((op) => op.kind === OperationKind.SyncExecute)
    const preview = result.operations.find((op) => op.kind === OperationKind.SyncPreview)
    const agent = result.operations.find((op) => op.kind === OperationKind.AgentRun)

    expect(execute?.title).toBe("Execute Contract — AccountClientMapping")
    expect(execute?.status).toBe(OperationStatus.Success)
    expect(execute?.activities.some((activity) => activity.name === "deploy-etl")).toBe(true)
    expect(preview?.title).toBe("Preview Contract — AccountClientMapping")
    expect(preview?.eventCount).toBe(1)
    expect(agent?.eventCount).toBe(3)
  })

  it("keeps execute lifecycle as top-level activities instead of attaching completion to the last step", async () => {
    listEvents.mockReturnValue([
      {
        type: EventType.SyncExecuteCompleted,
        created_at: "2026-05-27T14:52:27.000Z",
        data: JSON.stringify({ planId: "plan-2", applied: { insert: 0, update: 0, delete: 0 } }),
      },
      {
        type: EventType.SyncExecuteStep,
        created_at: "2026-05-27T14:52:26.000Z",
        data: JSON.stringify({ planId: "plan-2", step: "sync-date" }),
      },
      {
        type: EventType.SyncExecuteStarted,
        created_at: "2026-05-27T14:52:21.000Z",
        data: JSON.stringify({ planId: "plan-2", source: "dev", target: "uat" }),
      },
    ])

    getRun.mockReturnValue(undefined)
    getSyncRun.mockReturnValue({
      status: "success",
      finished_at: "2026-05-27T14:52:27.000Z",
      duration_ms: 6000,
      entity_display_name: "agent.vPipelineRunContract",
      entity_type: "dataset",
      entity_id: "6374",
      source: "dev",
      target: "uat",
      error: null,
    })

    const { listOperations } = await import("../src/api/operations-query.ts")
    const result = listOperations({ limit: 50 })
    const execute = result.operations[0]

    expect(execute.title).toBe("Execute Dataset — agent.vPipelineRunContract")
    expect(execute.activities).toHaveLength(3)
    expect(execute.activities[0]?.name).toBe("started")
    expect(execute.activities[0]?.status).toBe(OperationStatus.Success)
    expect(execute.activities[0]?.summary).toBe("dev → uat")
    expect(execute.activities[1]?.name).toBe("sync-date")
    expect(execute.activities[1]?.events.map((event) => event.type)).toEqual([
      EventType.SyncExecuteStep,
    ])
    expect(execute.activities[2]?.name).toBe("completed")
    expect(execute.activities[2]?.summary).toBe("0 ins · 0 upd · 0 del")
  })
})