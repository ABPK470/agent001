import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { SyncRunStatus } from "@mia/shared-enums"
import {
  getSyncRun,
  getSyncRunPlanJson,
  recordSyncRunPreview
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
})
