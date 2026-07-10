import { EventType, OperationKind, OperationStatus } from "@mia/shared-enums"
import { beforeEach, describe, expect, it, vi } from "vitest"

const listEvents = vi.fn()
const getRun = vi.fn()
const getSyncRun = vi.fn()
const getSyncRunPlanJson = vi.fn()

vi.mock("../src/platform/persistence/sqlite.js", () => ({
  listEvents,
  getRun,
  getSyncRun,
  getSyncRunPlanJson
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
        data: JSON.stringify({ runId: "run-1", planId: "plan-1", success: true })
      },
      {
        type: EventType.SyncExecuteCompleted,
        created_at: "2026-05-27T14:56:37.000Z",
        data: JSON.stringify({
          runId: "run-1",
          planId: "plan-1",
          applied: { insert: 0, update: 2, delete: 0 }
        })
      },
      {
        type: EventType.SyncExecuteStep,
        created_at: "2026-05-27T14:56:34.000Z",
        data: JSON.stringify({ runId: "run-1", planId: "plan-1", step: "deploy-etl" })
      },
      {
        type: EventType.SyncExecuteStarted,
        created_at: "2026-05-27T14:56:33.000Z",
        data: JSON.stringify({ runId: "run-1", planId: "plan-1", source: "dev", target: "uat" })
      },
      {
        type: EventType.SyncAgentExecuteStarted,
        created_at: "2026-05-27T14:56:32.000Z",
        data: JSON.stringify({ runId: "run-1", planId: "plan-1" })
      },
      {
        type: EventType.SyncPreviewCompleted,
        created_at: "2026-05-27T14:55:06.000Z",
        data: JSON.stringify({
          runId: "run-1",
          planId: "plan-1",
          totals: { insert: 0, update: 2, delete: 0 }
        })
      },
      {
        type: EventType.RunStarted,
        created_at: "2026-05-27T14:54:59.000Z",
        data: JSON.stringify({ runId: "run-1", goal: "run sync" })
      }
    ])

    getRun.mockReturnValue({
      status: "running",
      completed_at: null,
      goal: "run sync",
      step_count: 1,
      agent_id: "copilot",
      error: null
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
      error: null
    })

    const { listOperations } = await import("../src/features/operations/application/query/index.ts")
    const result = listOperations({ limit: 50 })

    expect(result.operations).toHaveLength(3)
    expect(result.operations.map((op) => op.kind)).toEqual([
      OperationKind.SyncExecute,
      OperationKind.SyncPreview,
      OperationKind.AgentRun
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
        data: JSON.stringify({ planId: "plan-2", applied: { insert: 0, update: 0, delete: 0 } })
      },
      {
        type: EventType.SyncExecuteStep,
        created_at: "2026-05-27T14:52:26.000Z",
        data: JSON.stringify({ planId: "plan-2", step: "syncDate" })
      },
      {
        type: EventType.SyncExecuteStarted,
        created_at: "2026-05-27T14:52:21.000Z",
        data: JSON.stringify({ planId: "plan-2", source: "dev", target: "uat" })
      }
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
      error: null
    })

    const { listOperations } = await import("../src/features/operations/application/query/index.ts")
    const result = listOperations({ limit: 50 })
    const execute = result.operations[0]

    expect(execute.title).toBe("Execute Dataset — agent.vPipelineRunContract")
    expect(execute.activities).toHaveLength(3)
    expect(execute.activities[0]?.name).toBe("started")
    expect(execute.activities[0]?.status).toBe(OperationStatus.Success)
    expect(execute.activities[0]?.summary).toBe("dev → uat")
    expect(execute.activities[1]?.name).toBe("syncDate")
    expect(execute.activities[1]?.events.map((event) => event.type)).toEqual([EventType.SyncExecuteStep])
    expect(execute.activities[2]?.name).toBe("completed")
    expect(execute.activities[2]?.summary).toBe("0 ins · 0 upd · 0 del")
  })

  it("renders persisted sync decision records as first-class activities", async () => {
    listEvents.mockReturnValue([
      {
        type: EventType.SyncExecuteCompleted,
        created_at: "2026-05-28T10:00:04.000Z",
        data: JSON.stringify({ planId: "plan-3", applied: { insert: 1, update: 0, delete: 0 } })
      },
      {
        type: EventType.SyncExecuteStep,
        created_at: "2026-05-28T10:00:03.000Z",
        data: JSON.stringify({ planId: "plan-3", step: "metadataSync" })
      },
      {
        type: EventType.SyncExecuteStarted,
        created_at: "2026-05-28T10:00:00.000Z",
        data: JSON.stringify({ planId: "plan-3", source: "dev", target: "uat" })
      }
    ])

    getRun.mockReturnValue(undefined)
    getSyncRun.mockReturnValue({
      status: "success",
      finished_at: "2026-05-28T10:00:04.000Z",
      duration_ms: 4000,
      entity_display_name: "AccountClientMapping",
      entity_type: "contract",
      entity_id: "4539",
      source: "dev",
      target: "uat",
      error: null
    })
    getSyncRunPlanJson.mockReturnValue(
      JSON.stringify({
        planId: "plan-3",
        source: "dev",
        target: "uat",
        entity: { type: "contract", id: "4539", displayName: "AccountClientMapping" },
        executionContract: {
          definitionId: "contract",
          definitionPublishedVersion: "2026-05-28T09:59:59.000Z"
        },
        decisionLog: [
          {
            id: "definition-contract",
            recordedAt: "2026-05-28T09:59:58.000Z",
            stage: "preview",
            category: "definition",
            severity: "info",
            title: "Published definition selected",
            summary: "Using published definition contract@2026-05-28T09:59:59.000Z."
          }
        ],
        warnings: []
      })
    )

    const { listOperations } = await import("../src/features/operations/application/query/index.ts")
    const result = listOperations({ limit: 50 })
    const execute = result.operations[0]

    expect(execute.title).toBe("Execute Contract — AccountClientMapping")
    expect(execute.subtitle).toContain("def 2026-05-28T09:59:59.000Z")
    expect(execute.activities[0]?.name).toBe("Published definition selected")
    expect(execute.activities[0]?.summary).toBe(
      "Using published definition contract@2026-05-28T09:59:59.000Z."
    )
    expect(execute.activities.some((activity) => activity.name === "metadataSync")).toBe(true)
  })

  it("correlates legacy preview events by previewId when planId is only on completed", async () => {
    const previewId = "prev-legacy-1"
    const planId = "plan-legacy-1"
    listEvents.mockReturnValue([
      {
        type: EventType.SyncPreviewCompleted,
        created_at: "2026-05-28T11:02:55.000Z",
        data: JSON.stringify({
          previewId,
          planId,
          totals: { insert: 102, update: 0, delete: 0 }
        })
      },
      {
        type: EventType.SyncPreviewTableDone,
        created_at: "2026-05-28T11:02:50.000Z",
        data: JSON.stringify({
          previewId,
          table: "Contract",
          counts: { insert: 100, update: 0, delete: 0 },
          durationMs: 1200
        })
      },
      {
        type: EventType.SyncPreviewTableStart,
        created_at: "2026-05-28T11:02:48.000Z",
        data: JSON.stringify({ previewId, table: "Contract" })
      },
      {
        type: EventType.SyncPreviewStarted,
        created_at: "2026-05-28T11:02:41.000Z",
        data: JSON.stringify({ previewId, source: "uat", target: "dev" })
      }
    ])

    getRun.mockReturnValue(undefined)
    getSyncRun.mockReturnValue({
      status: "success",
      finished_at: "2026-05-28T11:02:55.000Z",
      duration_ms: 14000,
      entity_display_name: "ACSRawTest",
      entity_type: "contract",
      entity_id: "5128",
      source: "uat",
      target: "dev",
      error: null
    })
    getSyncRunPlanJson.mockReturnValue(null)

    const { listOperations } = await import("../src/features/operations/application/query/index.ts")
    const result = listOperations({ limit: 50 })
    const preview = result.operations.find((op) => op.kind === OperationKind.SyncPreview)

    expect(preview).toBeDefined()
    expect(preview?.eventCount).toBe(4)
    expect(preview?.activities.some((a) => a.name === "Contract")).toBe(true)
    expect(preview?.activities.some((a) => a.name === "Preview started")).toBe(true)
    expect(preview?.activities.some((a) => a.name === "Preview completed")).toBe(true)
    const contract = preview?.activities.find((a) => a.name === "Contract")
    expect(contract?.summary).toBe("100 ins · 0 upd · 0 del · 1200ms")
    expect(contract?.events).toHaveLength(2)
  })

  it("exposes decision log details on activities without raw events", async () => {
    listEvents.mockReturnValue([
      {
        type: EventType.SyncPreviewCompleted,
        created_at: "2026-05-28T11:02:55.000Z",
        data: JSON.stringify({ planId: "plan-4", totals: { insert: 1, update: 0, delete: 0 } })
      },
      {
        type: EventType.SyncPreviewStarted,
        created_at: "2026-05-28T11:02:41.000Z",
        data: JSON.stringify({ planId: "plan-4", source: "uat", target: "dev" })
      }
    ])

    getRun.mockReturnValue(undefined)
    getSyncRun.mockReturnValue({
      status: "success",
      finished_at: "2026-05-28T11:02:55.000Z",
      duration_ms: 14000,
      entity_display_name: "ACSRawTest",
      entity_type: "contract",
      entity_id: "5128",
      source: "uat",
      target: "dev",
      error: null
    })
    getSyncRunPlanJson.mockReturnValue(
      JSON.stringify({
        planId: "plan-4",
        decisionLog: [
          {
            id: "table-scope",
            recordedAt: "2026-05-28T11:02:41.000Z",
            stage: "preview",
            category: "scope",
            severity: "info",
            title: "Table scope selected",
            summary: "8 table(s) included.",
            details: { tableCount: 8, excludedFkOnly: ["AuditLog"] }
          }
        ]
      })
    )

    const { listOperations } = await import("../src/features/operations/application/query/index.ts")
    const result = listOperations({ limit: 50 })
    const preview = result.operations[0]
    const scope = preview.activities.find((a) => a.name === "Table scope selected")

    expect(scope?.events).toHaveLength(0)
    expect(scope?.details).toEqual({ tableCount: 8, excludedFkOnly: ["AuditLog"] })
  })

  it("uses distinct pipeline ids and keeps execute skip metadata off preview rows", async () => {
    listEvents.mockReturnValue([
      {
        type: EventType.SyncExecuteSkipped,
        created_at: "2026-05-27T15:00:02.000Z",
        data: JSON.stringify({
          planId: "plan-skip",
          step: "auditCheck",
          message: "Source audit gate failed — execute skipped",
        }),
      },
      {
        type: EventType.SyncExecuteStarted,
        created_at: "2026-05-27T15:00:01.000Z",
        data: JSON.stringify({ planId: "plan-skip", source: "dev", target: "uat" }),
      },
      {
        type: EventType.SyncPreviewCompleted,
        created_at: "2026-05-27T14:59:00.000Z",
        data: JSON.stringify({
          planId: "plan-skip",
          totals: { insert: 0, update: 0, delete: 0 },
        }),
      },
    ])

    getSyncRun.mockReturnValue({
      status: "skipped",
      finished_at: "2026-05-27T15:00:02.000Z",
      duration_ms: 1000,
      entity_display_name: "Contract",
      entity_type: "contract",
      entity_id: "1",
      source: "dev",
      target: "uat",
      error: "Source audit gate failed — execute skipped",
    })

    const { listOperations } = await import("../src/features/operations/application/query/index.ts")
    const result = listOperations({ limit: 50 })

    const preview = result.operations.find((op) => op.kind === OperationKind.SyncPreview)
    const execute = result.operations.find((op) => op.kind === OperationKind.SyncExecute)

    expect(preview?.id).toBe("plan-skip:preview")
    expect(execute?.id).toBe("plan-skip:execute")
    expect(preview?.planId).toBe("plan-skip")
    expect(execute?.planId).toBe("plan-skip")
    expect(preview?.status).toBe(OperationStatus.Success)
    expect(preview?.error).toBeUndefined()
    expect(execute?.status).toBe(OperationStatus.Skipped)
    expect(execute?.error).toBe("Source audit gate failed — execute skipped")
    expect(execute?.activities.some((a) => a.name === "Execute skipped")).toBe(true)
  })
})
