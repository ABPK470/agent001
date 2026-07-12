import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { SyncRunStatus } from "@mia/shared-enums"
import {
  countSyncRuns,
  getSyncRun,
  getSyncRunPlanJson,
  listSyncRuns,
  listSyncRunsPaginated,
  recordSyncRunFinish,
  recordSyncRunPreview,
  recordSyncRunStart
} from "../src/platform/persistence/db/sync-runs.js"
import { seedUser } from "./_fk-helpers.js"

let testDb: Database.Database

describe("sync run persistence", () => {
  beforeEach(async () => {
    testDb = new Database(":memory:")
    const { _setDb, _migrate } = await import("../src/platform/persistence/db/index.js")
    _setDb(testDb)
    _migrate(testDb)
  })

  afterEach(() => {
    testDb.close()
  })

  it("recordSyncRunPreview persists plan_json with a real users.upn FK", () => {
    seedUser(testDb, "pka")
    const plan = {
      planId: "plan-1",
      entity: { displayName: "My Contract" },
      totals: { insert: 1, update: 0, delete: 0 },
      governanceDecision: { targetEnvironment: { actorUpn: "pka" } }
    }

    recordSyncRunPreview({
      planId: plan.planId,
      entityType: "Contract",
      entityId: 42,
      entityDisplayName: "My Contract",
      source: "dev",
      target: "uat",
      actorUpn: "pka",
      previewTotals: plan.totals,
      planJson: JSON.stringify(plan)
    })

    const row = getSyncRun("plan-1")
    expect(row?.actor_upn).toBe("pka")
    expect(row?.entity_display_name).toBe("My Contract")
    expect(row?.status).toBe(SyncRunStatus.Preview)
    expect(getSyncRunPlanJson("plan-1")).toContain("My Contract")
  })

  it("rejects preview rows without a valid users.upn reference", () => {
    expect(() =>
      recordSyncRunPreview({
        planId: "plan-2",
        entityType: "Contract",
        entityId: 1,
        entityDisplayName: null,
        source: "dev",
        target: "uat",
        actorUpn: null,
        previewTotals: {},
        planJson: "{}"
      })
    ).toThrow(/actor UPN is required/)
  })

  it("recordSyncRunStart preserves plan_json from preview", () => {
    seedUser(testDb, "pka")
    const plan = {
      planId: "plan-exec",
      entity: { displayName: "Exec Contract" },
      totals: { insert: 2, update: 0, delete: 0 },
      governanceDecision: { targetEnvironment: { actorUpn: "pka" } }
    }

    recordSyncRunPreview({
      planId: plan.planId,
      entityType: "contract",
      entityId: 99,
      entityDisplayName: "Exec Contract",
      source: "dev",
      target: "uat",
      actorUpn: "pka",
      previewTotals: plan.totals,
      planJson: JSON.stringify(plan)
    })

    recordSyncRunStart({
      planId: plan.planId,
      entityType: "contract",
      entityId: 99,
      entityDisplayName: "Exec Contract",
      source: "dev",
      target: "uat",
      actorUpn: "pka",
      previewTotals: plan.totals
    })

    expect(getSyncRunPlanJson("plan-exec")).toContain("Exec Contract")
    expect(getSyncRun("plan-exec")?.status).toBe(SyncRunStatus.Started)
  })

  it("recordSyncRunFinish without executeTotals preserves executed counts", () => {
    seedUser(testDb, "pka")
    recordSyncRunPreview({
      planId: "plan-finish",
      entityType: "contract",
      entityId: 1,
      entityDisplayName: null,
      source: "dev",
      target: "uat",
      actorUpn: "pka",
      previewTotals: { insert: 0, update: 2, delete: 0 },
      planJson: "{}"
    })
    recordSyncRunFinish({
      planId: "plan-finish",
      status: SyncRunStatus.Success,
      executeTotals: { insert: 2, update: 0, delete: 0 },
      durationMs: 1200
    })
    recordSyncRunFinish({
      planId: "plan-finish",
      status: SyncRunStatus.Success,
      durationMs: 1300
    })

    const row = getSyncRun("plan-finish")
    expect(row?.executed_inserts).toBe(2)
    expect(row?.executed_updates).toBe(0)
    expect(row?.duration_ms).toBe(1300)
  })

  it("lists sync runs with pagination", () => {
    seedUser(testDb, "pka")
    for (let i = 0; i < 5; i++) {
      recordSyncRunPreview({
        planId: `plan-${i}`,
        entityType: "Contract",
        entityId: i,
        entityDisplayName: null,
        source: "dev",
        target: "uat",
        actorUpn: "pka",
        previewTotals: { insert: 0, update: 0, delete: 0 },
        planJson: "{}"
      })
    }
    expect(countSyncRuns({ actorUpn: "pka" })).toBe(5)
    const page1 = listSyncRunsPaginated({ page: 1, pageSize: 2, actorUpn: "pka" })
    expect(page1).toHaveLength(2)
    const page3 = listSyncRunsPaginated({ page: 3, pageSize: 2, actorUpn: "pka" })
    expect(page3).toHaveLength(1)
  })

  it("filters sync runs by status, search, direction, and date range", () => {
    seedUser(testDb, "pka")
    seedUser(testDb, "bob")
    recordSyncRunPreview({
      planId: "plan-alpha",
      entityType: "contract",
      entityId: "1",
      entityDisplayName: "Alpha Contract",
      source: "dev",
      target: "uat",
      actorUpn: "pka",
      previewTotals: { insert: 1, update: 0, delete: 0 },
      planJson: "{}"
    })
    recordSyncRunPreview({
      planId: "plan-beta",
      entityType: "employee",
      entityId: "2",
      entityDisplayName: "Beta Employee",
      source: "dev",
      target: "prod",
      actorUpn: "bob",
      previewTotals: { insert: 0, update: 1, delete: 0 },
      planJson: "{}"
    })
    testDb.prepare(`UPDATE sync_runs SET started_at = ?, status = ? WHERE plan_id = ?`).run(
      "2026-01-10 08:00:00",
      SyncRunStatus.Success,
      "plan-alpha"
    )
    testDb.prepare(`UPDATE sync_runs SET started_at = ? WHERE plan_id = ?`).run(
      "2026-02-20 12:00:00",
      "plan-beta"
    )

    expect(countSyncRuns({ status: [SyncRunStatus.Preview] })).toBe(1)
    expect(countSyncRuns({ status: [SyncRunStatus.Success] })).toBe(1)
    expect(countSyncRuns({ search: "Alpha" })).toBe(1)
    expect(countSyncRuns({ actorUpn: "bob" })).toBe(1)
    expect(countSyncRuns({ source: "dev", target: "prod" })).toBe(1)
    expect(countSyncRuns({ startedAfter: "2026-02-01" })).toBe(1)
    expect(countSyncRuns({ startedBefore: "2026-01-31" })).toBe(1)

    const asc = listSyncRunsPaginated({ page: 1, pageSize: 10, sort: "started_asc" })
    expect(asc[0]?.plan_id).toBe("plan-alpha")
    expect(asc[1]?.plan_id).toBe("plan-beta")
  })
})
