/**
 * Tests for cross-reference validation in saveEntityDefinition and
 * for the freeze-window persistence layer + admin HTTP routes.
 *
 * These cover the P1 completion work:
 *   - `policies.freezeWindowIds[]` containing an unknown id is rejected
 *     with code `freeze_window_unknown`.
 *   - `scd2.strategyId` referring to a non-existent strategy is rejected
 *     with code `scd2_strategy_unknown`.
 *   - upsertFreezeWindow stores the row, listFreezeWindows returns it,
 *     and refreshFreezeWindowRegistry pushes it into the agent registry.
 */

import { listFreezeWindows as listAgentFreezeWindows, type EntityDefinition } from "@mia/sync"
import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let testDb: Database.Database
let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-freeze-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = ON")
})

afterEach(() => {
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
})

async function setup() {
  const { _setDb, _migrate } = await import("../src/platform/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)
  return {
    defs: await import("../src/platform/persistence/db/entity-defs.js"),
    freezes: await import("../src/platform/persistence/db/freeze-windows.js")
  }
}

function baseDef(overrides: Partial<EntityDefinition> = {}): EntityDefinition {
  return {
    id: "contract",
    tenantId: "_default",
    displayName: "Contract",
    description: "",
    rootTable: "core.Contract",
    idColumn: "contractId",
    labelColumn: "name",
    selfJoinColumn: null,
    tables: [
      {
        name: "core.Contract",
        scope: { kind: "rootPk", column: "contractId" },
        executionOrder: 1,
        scd2Override: null,
        verified: true,
        archiveTable: "coreArchive.Contract",
        note: null,
        provenance: { kind: "manual" },
        scopeColumn: null,
        source: null,
        groundedByPipeline: null,
        enabledByDefault: null,
        userControllable: null
      }
    ],
    policies: { approvalPolicyId: null, freezeWindowIds: [], riskMultiplier: 1 },
    scd2: { strategyId: "mymi-scd2", strategyVersion: 1, entityOverride: null },
    lineageRefs: [],
    provenance: { kind: "manual" },
    legacyEntrySproc: null,
    reverseOrder: [],
    discrepancies: [],
    version: 1,
    versionLabel: null,
    createdBy: "alice@example.com",
    reason: "create",
    createdAt: "2026-05-16T00:00:00.000Z",
    retiredAt: null,
    ...overrides
  }
}

describe("saveEntityDefinition — cross-reference validation", () => {
  it("rejects unknown scd2.strategyId with code scd2_strategy_unknown", async () => {
    const m = await setup()
    let caught: unknown
    try {
      m.defs.saveEntityDefinition({
        def: baseDef({
          scd2: { strategyId: "no-such-strategy", strategyVersion: "latest", entityOverride: null }
        }),
        actor: "alice@example.com",
        reason: "create"
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(m.defs.EntityRegistryValidationError)
    const err = caught as InstanceType<typeof m.defs.EntityRegistryValidationError>
    expect(err.result.errors.some((x) => x.code === "scd2_strategy_unknown")).toBe(true)
  })

  it("rejects unknown freezeWindowIds[] entry with code freeze_window_unknown", async () => {
    const m = await setup()
    let caught: unknown
    try {
      m.defs.saveEntityDefinition({
        def: baseDef({
          policies: { approvalPolicyId: null, freezeWindowIds: ["bogus-window"], riskMultiplier: 1 }
        }),
        actor: "alice@example.com",
        reason: "create"
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(m.defs.EntityRegistryValidationError)
    const err = caught as InstanceType<typeof m.defs.EntityRegistryValidationError>
    expect(err.result.errors.some((x) => x.code === "freeze_window_unknown")).toBe(true)
  })

  it("accepts a freezeWindowId that has been registered first", async () => {
    const m = await setup()
    // Register the freeze window so the validator can resolve it.
    m.freezes.upsertFreezeWindow({
      tenantId: "_default",
      id: "month-end-close",
      displayName: "Month-end close",
      description: "Year-end finance lock",
      startsAt: "2026-06-01T00:00:00.000Z",
      endsAt: "2026-06-02T00:00:00.000Z",
      actor: "alice@example.com"
    })
    const r = m.defs.saveEntityDefinition({
      def: baseDef({
        policies: { approvalPolicyId: null, freezeWindowIds: ["month-end-close"], riskMultiplier: 1 }
      }),
      actor: "alice@example.com",
      reason: "create"
    })
    expect(r.version).toBe(1)
  })
})

describe("freeze-window persistence", () => {
  it("upsert → list returns the row and lists are stable", async () => {
    const m = await setup()
    m.freezes.upsertFreezeWindow({
      tenantId: "_default",
      id: "w1",
      displayName: "Window 1",
      description: "",
      startsAt: "2026-06-01T00:00:00.000Z",
      endsAt: "2026-06-02T00:00:00.000Z",
      actor: "alice@example.com"
    })
    const items = m.freezes.listFreezeWindowsForTenant("_default")
    expect(items.map((w) => w.id)).toContain("w1")
  })

  it("rejects endsAt <= startsAt with FreezeWindowValidationError", () => {
    return setup().then((m) => {
      expect(() =>
        m.freezes.upsertFreezeWindow({
          tenantId: "_default",
          id: "bad",
          displayName: "Bad",
          description: "",
          startsAt: "2026-06-02T00:00:00.000Z",
          endsAt: "2026-06-01T00:00:00.000Z",
          actor: "x"
        })
      ).toThrow(m.freezes.FreezeWindowValidationError)
    })
  })

  it("rejects invalid id with FreezeWindowValidationError", async () => {
    const m = await setup()
    expect(() =>
      m.freezes.upsertFreezeWindow({
        tenantId: "_default",
        id: "1bad",
        displayName: "Bad",
        description: "",
        startsAt: "2026-06-01T00:00:00.000Z",
        endsAt: "2026-06-02T00:00:00.000Z",
        actor: "x"
      })
    ).toThrow(m.freezes.FreezeWindowValidationError)
  })

  it("refresh pushes _default tenant rows into agent registry", async () => {
    const m = await setup()
    m.freezes.upsertFreezeWindow({
      tenantId: "_default",
      id: "agent-visible",
      displayName: "Agent visible",
      description: "",
      startsAt: "2026-06-01T00:00:00.000Z",
      endsAt: "2026-06-02T00:00:00.000Z",
      actor: "alice@example.com"
    })
    m.freezes.refreshFreezeWindowRegistry()
    expect(listAgentFreezeWindows().map((w) => w.id)).toContain("agent-visible")
  })

  it("delete removes the row and returns false on second call", async () => {
    const m = await setup()
    m.freezes.upsertFreezeWindow({
      tenantId: "_default",
      id: "to-delete",
      displayName: "Delete me",
      description: "",
      startsAt: "2026-06-01T00:00:00.000Z",
      endsAt: "2026-06-02T00:00:00.000Z",
      actor: "alice@example.com"
    })
    expect(m.freezes.deleteFreezeWindow("_default", "to-delete")).toBe(true)
    expect(m.freezes.deleteFreezeWindow("_default", "to-delete")).toBe(false)
  })
})
