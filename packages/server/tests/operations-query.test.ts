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

    expect(result.operations).toHaveLength(2)
    expect(result.operations.map((op) => op.kind)).toEqual([
      OperationKind.SyncRun,
      OperationKind.AgentRun
    ])

    const syncRun = result.operations.find((op) => op.kind === OperationKind.SyncRun)
    const agent = result.operations.find((op) => op.kind === OperationKind.AgentRun)

    expect(syncRun?.id).toBe("plan-1")
    expect(syncRun?.activities.map((a) => a.name)).toEqual(["Preview", "Execute"])
    expect(syncRun?.activities[1]?.children?.some((activity) => activity.name === "deploy-etl")).toBe(true)
    expect(syncRun?.status).toBe(OperationStatus.Success)
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

    expect(execute.kind).toBe(OperationKind.SyncRun)
    expect(execute.title).toBe("Sync Dataset — agent.vPipelineRunContract")
    const executePhase = execute.activities.find((a) => a.name === "Execute")
    expect(executePhase?.children).toHaveLength(3)
    expect(executePhase?.children?.[0]?.name).toBe("started")
    expect(executePhase?.children?.[0]?.status).toBe(OperationStatus.Success)
    expect(executePhase?.children?.[0]?.summary).toBe("dev → uat")
    expect(executePhase?.children?.[1]?.name).toBe("syncDate")
    expect(executePhase?.children?.[1]?.events.map((event) => event.type)).toEqual([EventType.SyncExecuteStep])
    expect(executePhase?.children?.[2]?.name).toBe("completed")
    expect(executePhase?.children?.[2]?.summary).toBe("0 ins · 0 upd · 0 del")
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
    const executePhase = execute.activities.find((a) => a.name === "Execute")

    expect(execute.title).toBe("Sync Contract — AccountClientMapping")
    expect(execute.subtitle).toContain("def 2026-05-28T09:59:59.000Z")
    expect(executePhase?.children?.[0]?.name).toBe("Preflight checks")
    expect(executePhase?.children?.[0]?.summary).toBe("1 check(s) from preview")
    expect(executePhase?.children?.some((activity) => activity.name === "metadataSync")).toBe(true)
  })

  it("groups metadata table work under the metadataSync flow step and fails open tables on rollback", async () => {
    listEvents.mockReturnValue([
      {
        type: EventType.SyncExecuteFailed,
        created_at: "2026-07-12T15:21:00.000Z",
        data: JSON.stringify({
          planId: "plan-meta-fail",
          error: "metadataSync / upsert / core.DatasetMapping failed",
          step: "metadataSync",
          table: "core.DatasetMapping",
          op: "upsert"
        })
      },
      {
        type: EventType.SyncExecuteStepFailed,
        created_at: "2026-07-12T15:20:59.000Z",
        data: JSON.stringify({
          planId: "plan-meta-fail",
          step: "metadataSync",
          table: "core.DatasetMapping",
          op: "upsert",
          error: "metadataSync / upsert / core.DatasetMapping failed"
        })
      },
      {
        type: EventType.SyncExecuteTableStart,
        created_at: "2026-07-12T15:20:58.000Z",
        data: JSON.stringify({
          planId: "plan-meta-fail",
          table: "core.DatasetMapping",
          op: "upsert",
          rowsTotal: 3
        })
      },
      {
        type: EventType.SyncExecuteTableStart,
        created_at: "2026-07-12T15:20:56.000Z",
        data: JSON.stringify({
          planId: "plan-meta-fail",
          table: "core.ContractColumn",
          op: "upsert",
          rowsTotal: 1
        })
      },
      {
        type: EventType.SyncExecuteArchiveProbeBatch,
        created_at: "2026-07-12T15:20:54.500Z",
        data: JSON.stringify({ planId: "plan-meta-fail", tables: ["core.ContractColumn"], durationMs: 468 })
      },
      {
        type: EventType.SyncExecuteStep,
        created_at: "2026-07-12T15:20:54.000Z",
        data: JSON.stringify({ planId: "plan-meta-fail", step: "metadataSync" })
      },
      {
        type: EventType.SyncExecuteStep,
        created_at: "2026-07-12T15:20:53.500Z",
        data: JSON.stringify({ planId: "plan-meta-fail", step: "targetLock" })
      },
      {
        type: EventType.SyncExecuteStep,
        created_at: "2026-07-12T15:20:53.000Z",
        data: JSON.stringify({ planId: "plan-meta-fail", step: "auditCheck" })
      },
      {
        type: EventType.SyncExecuteStarted,
        created_at: "2026-07-12T15:20:50.000Z",
        data: JSON.stringify({ planId: "plan-meta-fail", source: "uat", target: "dev" })
      }
    ])

    getRun.mockReturnValue(undefined)
    getSyncRun.mockReturnValue({
      status: "failed",
      finished_at: "2026-07-12T15:21:00.000Z",
      duration_ms: 10000,
      entity_display_name: "Contract",
      entity_type: "contract",
      entity_id: "1",
      source: "uat",
      target: "dev",
      error: "metadataSync / upsert / core.DatasetMapping failed"
    })
    getSyncRunPlanJson.mockReturnValue(null)

    const { listOperations } = await import("../src/features/operations/application/query/index.ts")
    const result = listOperations({ limit: 50 })
    const execute = result.operations[0]
    const executePhase = execute.activities.find((a) => a.name === "Execute")

    expect(executePhase?.children?.map((a) => a.name)).toEqual([
      "started",
      "auditCheck",
      "targetLock",
      "metadataSync",
      "failed"
    ])
    expect(executePhase?.children?.some((a) => a.name === "archive.probe.batch")).toBe(false)

    const metadata = executePhase?.children?.find((a) => a.name === "metadataSync")
    expect(metadata?.status).toBe(OperationStatus.Failed)
    expect(metadata?.children).toHaveLength(2)
    expect(metadata?.children?.map((c) => c.name)).toEqual([
      "core.ContractColumn",
      "core.DatasetMapping"
    ])
    expect(metadata?.children?.every((c) => c.status === OperationStatus.Failed)).toBe(true)
    expect(metadata?.children?.every((c) => c.summary === "Rolled back — not committed")).toBe(true)
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
    const preview = result.operations.find((op) => op.kind === OperationKind.SyncRun)

    expect(preview).toBeDefined()
    expect(preview?.eventCount).toBe(4)
    expect(preview?.activities[0]?.name).toBe("Preview")
    const previewPhase = preview?.activities[0]
    expect(previewPhase?.children?.some((a) => a.name === "Contract")).toBe(true)
    expect(previewPhase?.children?.some((a) => a.name === "started")).toBe(true)
    expect(previewPhase?.children?.some((a) => a.name === "completed")).toBe(true)
    const contract = previewPhase?.children?.find((a) => a.name === "Contract")
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
    const preview = result.operations.find((op) => op.kind === OperationKind.SyncRun)
    const scope = preview?.activities[0]?.children?.find((a) => a.name === "Preflight checks")

    expect(scope?.events).toHaveLength(0)
    expect(scope?.details?.["decisions"]).toEqual([
      expect.objectContaining({
        details: { tableCount: 8, excludedFkOnly: ["AuditLog"] }
      })
    ])
  })

  it("orders agent run activities chronologically with sync delegation markers", async () => {
    listEvents.mockReturnValue([
      {
        type: EventType.RunCompleted,
        created_at: "2026-05-27T14:56:38.000Z",
        data: JSON.stringify({ runId: "run-agent-1" })
      },
      {
        type: EventType.SyncAgentExecuteCompleted,
        created_at: "2026-05-27T14:56:37.500Z",
        data: JSON.stringify({ runId: "run-agent-1", planId: "plan-1", success: true })
      },
      {
        type: EventType.SyncAgentExecuteStarted,
        created_at: "2026-05-27T14:56:34.500Z",
        data: JSON.stringify({ runId: "run-agent-1", planId: "plan-1" })
      },
      {
        type: EventType.StepCompleted,
        created_at: "2026-05-27T14:56:34.000Z",
        data: JSON.stringify({ runId: "run-agent-1", tool: "sync_execute", durationMs: 3200 })
      },
      {
        type: EventType.StepStarted,
        created_at: "2026-05-27T14:56:33.500Z",
        data: JSON.stringify({ runId: "run-agent-1", tool: "sync_execute" })
      },
      {
        type: EventType.SyncAgentPreview,
        created_at: "2026-05-27T14:56:33.000Z",
        data: JSON.stringify({
          runId: "run-agent-1",
          planId: "plan-1",
          source: "dev",
          target: "uat"
        })
      },
      {
        type: EventType.RunStarted,
        created_at: "2026-05-27T14:56:32.000Z",
        data: JSON.stringify({ runId: "run-agent-1", goal: "sync contract" })
      }
    ])

    getRun.mockReturnValue({
      status: "completed",
      completed_at: "2026-05-27T14:56:38.000Z",
      goal: "sync contract",
      step_count: 1,
      agent_id: "copilot",
      error: null
    })
    getSyncRun.mockReturnValue(undefined)

    const { listOperations } = await import("../src/features/operations/application/query/index.ts")
    const agent = listOperations({ limit: 50 }).operations.find((op) => op.kind === OperationKind.AgentRun)

    expect(agent?.activities.map((a) => a.name)).toEqual([
      "started",
      "Sync preview",
      "sync_execute",
      "Sync execute",
      "completed"
    ])
    expect(agent?.activities[1]?.details).toEqual({
      planId: "plan-1",
      phase: "preview",
      auditHint: "Open full sync audit in Pipelines"
    })
    expect(agent?.activities[3]?.status).toBe(OperationStatus.Success)
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

    const preview = result.operations.find((op) => op.id === "plan-skip")
    const executePhase = preview?.activities.find((a) => a.name === "Execute")

    expect(preview?.kind).toBe(OperationKind.SyncRun)
    expect(preview?.id).toBe("plan-skip")
    expect(preview?.planId).toBe("plan-skip")
    expect(preview?.status).toBe(OperationStatus.Skipped)
    expect(preview?.activities[0]?.name).toBe("Preview")
    expect(preview?.activities[0]?.status).toBe(OperationStatus.Success)
    expect(preview?.activities[0]?.error).toBeUndefined()
    expect(executePhase?.status).toBe(OperationStatus.Skipped)
    expect(executePhase?.error).toBe("Source audit gate failed — execute skipped")
    expect(executePhase?.children?.some((a) => a.name === "Execute skipped")).toBe(true)
  })
})
