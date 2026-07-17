import { EventType, OperationKind, OperationStatus } from "@mia/shared-enums"
import { beforeEach, describe, expect, it, vi } from "vitest"

const listEventsForPlanId = vi.fn()
const getSyncRun = vi.fn()
const getSyncRunPlanJson = vi.fn()

vi.mock("../src/infra/persistence/sqlite.js", () => ({
  listEventsForPlanId,
  getSyncRun,
  getSyncRunPlanJson
}))

describe("listOperationsForPlan", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it("builds a unified sync-run pipeline with preview and execute phases", async () => {
    const planId = "plan-audit-1"
    listEventsForPlanId.mockReturnValue([
      {
        id: 1,
        type: EventType.SyncPreviewStarted,
        created_at: "2026-07-12T10:00:00.000Z",
        data: JSON.stringify({ planId, source: "dev", target: "uat" })
      },
      {
        id: 2,
        type: EventType.SyncPreviewCompleted,
        created_at: "2026-07-12T10:00:30.000Z",
        data: JSON.stringify({ planId, totals: { insert: 1, update: 0, delete: 0 } })
      },
      {
        id: 3,
        type: EventType.SyncExecuteStarted,
        created_at: "2026-07-12T10:01:00.000Z",
        data: JSON.stringify({ planId, source: "dev", target: "uat" })
      },
      {
        id: 4,
        type: EventType.SyncExecuteCompleted,
        created_at: "2026-07-12T10:01:20.000Z",
        data: JSON.stringify({ planId, applied: { insert: 1, update: 0, delete: 0 } })
      }
    ])

    getSyncRun.mockReturnValue({
      status: "success",
      finished_at: "2026-07-12T10:01:20.000Z",
      duration_ms: 80_000,
      entity_display_name: "ContractA",
      entity_type: "contract",
      entity_id: "42",
      source: "dev",
      target: "uat",
      error: null
    })
    getSyncRunPlanJson.mockReturnValue(null)

    const { listOperationsForPlan } = await import(
      "../src/api/operations/application/query/list-operations-for-plan.ts"
    )
    const result = listOperationsForPlan(planId)

    expect(result.scannedEvents).toBe(4)
    expect(result.operation).toBeDefined()
    expect(result.operation?.kind).toBe(OperationKind.SyncRun)
    expect(result.operation?.id).toBe(planId)
    expect(result.operation?.title).toBe("Sync Contract — ContractA")
    expect(result.operation?.activities.map((a) => a.name)).toEqual(["Preview", "Execute"])
    expect(result.operation?.activities[0]?.children?.some((c) => c.name === "completed")).toBe(true)
    expect(result.operation?.activities[1]?.children?.some((c) => c.name === "completed")).toBe(true)
    expect(result.operation?.status).toBe(OperationStatus.Success)
  })

  it("returns null when no events exist for the plan", async () => {
    listEventsForPlanId.mockReturnValue([])

    const { listOperationsForPlan } = await import(
      "../src/api/operations/application/query/list-operations-for-plan.ts"
    )
    const result = listOperationsForPlan("missing-plan")

    expect(result.operation).toBeNull()
    expect(result.scannedEvents).toBe(0)
  })
})
