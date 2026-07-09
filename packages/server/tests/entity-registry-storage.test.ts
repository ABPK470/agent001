/**
 * Tests for the entity registry persistence layer
 * (packages/server/src/db/entity-defs.ts).
 *
 * Covers:
 *   - bundled SCD2 strategies are seeded on migrate
 *   - saveEntityDefinition inserts pointer + version atomically and
 *     bumps the version on subsequent saves
 *   - history endpoint returns newest-first with attached diffs
 *   - retire flips the pointer and (by default) hides the entity
 *   - DB triggers refuse UPDATE/DELETE on the *_versions tables
 *   - resolveScd2Strategy falls back tenant → default → bundled
 *   - listAvailableStrategies inherits defaults the tenant hasn't shadowed
 *   - validation failures throw EntityRegistryValidationError
 */

import { BUNDLED_SCD2_STRATEGIES, type EntityDefinition, type Scd2Strategy } from "@mia/sync"
import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let testDb: Database.Database
let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-entity-"))
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
  return import("../src/platform/persistence/db/entity-defs.js")
}

function validDef(overrides: Partial<EntityDefinition> = {}): EntityDefinition {
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
    policies: { approvalPolicyId: null, freezeWindowIds: [] },
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

describe("entity registry seed", () => {
  it("populates _default tenant with all bundled strategies", async () => {
    await setup()
    const seeded = testDb
      .prepare(`SELECT id, current_version FROM scd2_strategies WHERE tenant_id = '_default' ORDER BY id`)
      .all() as { id: string; current_version: number }[]
    const ids = seeded.map((s) => s.id).sort()
    expect(ids).toEqual(BUNDLED_SCD2_STRATEGIES.map((s) => s.id).sort())
    for (const row of seeded) {
      expect(row.current_version).toBe(1)
    }
  })

  it("seed is idempotent across repeated _migrate calls", async () => {
    const { _migrate } = await import("../src/platform/persistence/db/index.js")
    _migrate(testDb)
    _migrate(testDb)
    _migrate(testDb)
    const count = testDb
      .prepare(`SELECT COUNT(*) AS n FROM scd2_strategy_versions WHERE tenant_id = '_default'`)
      .get() as { n: number }
    expect(count.n).toBe(BUNDLED_SCD2_STRATEGIES.length)
  })
})

describe("saveEntityDefinition + getEntityDefinition", () => {
  it("creates v1 on first save", async () => {
    const m = await setup()
    const r = m.saveEntityDefinition({
      def: validDef(),
      actor: "alice@example.com",
      reason: "create"
    })
    expect(r.version).toBe(1)
    const fetched = m.getEntityDefinition("_default", "contract")
    expect(fetched).not.toBeNull()
    expect(fetched!.displayName).toBe("Contract")
    expect(fetched!.version).toBe(1)
    expect(fetched!.createdBy).toBe("alice@example.com")
  })

  it("renumbers duplicate execution orders on save and read", async () => {
    const m = await setup()
    const base = validDef().tables[0]!
    m.saveEntityDefinition({
      def: validDef({
        tables: [
          { ...base, name: "core.A", executionOrder: 0 },
          { ...base, name: "core.B", executionOrder: 0 },
          { ...base, name: "core.C", executionOrder: 2 },
        ],
      }),
      actor: "alice@example.com",
      reason: "create",
    })
    const fetched = m.getEntityDefinition("_default", "contract")
    expect(fetched?.tables.map((table) => table.executionOrder).sort((a, b) => a - b)).toEqual([1, 2, 3])
  })

  it("bumps version on each subsequent save", async () => {
    const m = await setup()
    m.saveEntityDefinition({ def: validDef(), actor: "alice@example.com", reason: "create" })
    const r2 = m.saveEntityDefinition({
      def: validDef({ displayName: "Contract v2" }),
      actor: "bob@example.com",
      reason: "rename"
    })
    expect(r2.version).toBe(2)
    expect(r2.diff.some((c) => c.kind === "renamed")).toBe(true)

    const current = m.getEntityDefinition("_default", "contract")
    expect(current!.version).toBe(2)
    expect(current!.displayName).toBe("Contract v2")
    expect(current!.createdBy).toBe("bob@example.com")

    const v1 = m.getEntityDefinition("_default", "contract", { version: 1 })
    expect(v1!.displayName).toBe("Contract")
  })

  it("ignores caller-supplied version field", async () => {
    const m = await setup()
    const r = m.saveEntityDefinition({
      def: validDef({ version: 999 }),
      actor: "a",
      reason: "create"
    })
    expect(r.version).toBe(1)
  })

  it("throws EntityRegistryValidationError on invalid def", async () => {
    const m = await setup()
    expect(() =>
      m.saveEntityDefinition({
        def: validDef({ id: "1invalid" }),
        actor: "a",
        reason: "create"
      })
    ).toThrow(m.EntityRegistryValidationError)
  })

  it("rejects createOnly when entity id already exists", async () => {
    const m = await setup()
    m.saveEntityDefinition({ def: validDef({ id: "content" }), actor: "u", reason: "create" })
    expect(() =>
      m.saveEntityDefinition({
        def: validDef({ id: "content", displayName: "Duplicate" }),
        actor: "u",
        reason: "create",
        createOnly: true,
      }),
    ).toThrow(m.EntityRegistryConflictError)
  })

  it("rejects createOnly for retired entity ids", async () => {
    const m = await setup()
    m.saveEntityDefinition({ def: validDef({ id: "content" }), actor: "u", reason: "create" })
    m.retireEntityDefinition("_default", "content", "u")
    expect(() =>
      m.saveEntityDefinition({
        def: validDef({ id: "content", displayName: "Revived" }),
        actor: "u",
        reason: "create",
        createOnly: true,
      }),
    ).toThrow(m.EntityRegistryConflictError)
    expect(m.listEntityDefinitions("_default")).toEqual([])
  })

  it("stores the diff alongside the version row", async () => {
    const m = await setup()
    m.saveEntityDefinition({ def: validDef(), actor: "a", reason: "create" })
    m.saveEntityDefinition({
      def: validDef({ displayName: "X" }),
      actor: "a",
      reason: "rename"
    })
    const row = testDb
      .prepare(
        `SELECT diff_json FROM entity_def_versions WHERE tenant_id = '_default' AND id = 'contract' AND version = 2`
      )
      .get() as { diff_json: string }
    const diff = JSON.parse(row.diff_json)
    expect(Array.isArray(diff)).toBe(true)
    expect(diff.some((c: { kind: string }) => c.kind === "renamed")).toBe(true)
  })
})

describe("listEntityDefinitions + history", () => {
  it("lists current versions excluding retired by default", async () => {
    const m = await setup()
    m.saveEntityDefinition({ def: validDef({ id: "a" }), actor: "u", reason: "" })
    m.saveEntityDefinition({ def: validDef({ id: "b" }), actor: "u", reason: "" })
    m.saveEntityDefinition({ def: validDef({ id: "c" }), actor: "u", reason: "" })
    m.retireEntityDefinition("_default", "b", "u")

    const ids = m.listEntityDefinitions("_default").map((d) => d.id)
    expect(ids).toEqual(["a", "c"])

    const allIds = m.listEntityDefinitions("_default", { includeRetired: true }).map((d) => d.id)
    expect(allIds).toEqual(["a", "b", "c"])
  })

  it("history is newest-first with attached diffs", async () => {
    const m = await setup()
    m.saveEntityDefinition({ def: validDef(), actor: "u", reason: "create" })
    m.saveEntityDefinition({ def: validDef({ displayName: "v2" }), actor: "u", reason: "rename" })
    m.saveEntityDefinition({ def: validDef({ displayName: "v3" }), actor: "u", reason: "rename2" })

    const hist = m.listEntityDefinitionHistory("_default", "contract")
    expect(hist.map((h) => h.version)).toEqual([3, 2, 1])
    expect(hist[0]!.reason).toBe("rename2")
    expect(Array.isArray(hist[0]!.diff)).toBe(true)
  })
})

describe("retireEntityDefinition", () => {
  it("hides retired entity from default list and get", async () => {
    const m = await setup()
    m.saveEntityDefinition({ def: validDef(), actor: "u", reason: "" })
    const r = m.retireEntityDefinition("_default", "contract", "admin")
    expect(r).not.toBeNull()
    expect(m.getEntityDefinition("_default", "contract")).toBeNull()
    const surfaced = m.getEntityDefinition("_default", "contract", { includeRetired: true })
    expect(surfaced).not.toBeNull()
    expect(surfaced!.retiredAt).toBe(r!.retiredAt)
  })

  it("returns null when retiring an unknown entity", async () => {
    const m = await setup()
    expect(m.retireEntityDefinition("_default", "missing", "admin")).toBeNull()
  })

  it("records the retire as a new version with reason='retire'", async () => {
    const m = await setup()
    m.saveEntityDefinition({ def: validDef(), actor: "u", reason: "create" })
    m.retireEntityDefinition("_default", "contract", "admin")
    const hist = m.listEntityDefinitionHistory("_default", "contract")
    expect(hist[0]!.reason).toBe("retire")
    expect(hist[0]!.createdBy).toBe("admin")
  })

  it("is idempotent (second retire returns the original timestamp)", async () => {
    const m = await setup()
    m.saveEntityDefinition({ def: validDef(), actor: "u", reason: "" })
    const r1 = m.retireEntityDefinition("_default", "contract", "admin")!
    const r2 = m.retireEntityDefinition("_default", "contract", "admin")!
    expect(r2.retiredAt).toBe(r1.retiredAt)
  })
})

describe("immutability triggers", () => {
  it("refuses UPDATE on entity_def_versions", async () => {
    const m = await setup()
    m.saveEntityDefinition({ def: validDef(), actor: "u", reason: "" })
    expect(() =>
      testDb.prepare(`UPDATE entity_def_versions SET reason = 'tampered' WHERE id = 'contract'`).run()
    ).toThrow(/append-only/)
  })

  it("refuses DELETE on entity_def_versions", async () => {
    const m = await setup()
    m.saveEntityDefinition({ def: validDef(), actor: "u", reason: "" })
    expect(() => testDb.prepare(`DELETE FROM entity_def_versions WHERE id = 'contract'`).run()).toThrow(
      /append-only/
    )
  })

  it("refuses UPDATE on scd2_strategy_versions", async () => {
    await setup()
    expect(() =>
      testDb.prepare(`UPDATE scd2_strategy_versions SET reason = 'tampered' WHERE id = 'mymi-scd2'`).run()
    ).toThrow(/append-only/)
  })

  it("refuses DELETE on scd2_strategy_versions", async () => {
    await setup()
    expect(() => testDb.prepare(`DELETE FROM scd2_strategy_versions WHERE id = 'mymi-scd2'`).run()).toThrow(
      /append-only/
    )
  })

  it("wipeEntityRegistry clears rows and restores append-only triggers", async () => {
    const m = await setup()
    m.saveEntityDefinition({ def: validDef(), actor: "u", reason: "" })
    expect(testDb.prepare(`SELECT COUNT(*) AS c FROM entity_defs`).get()).toEqual({ c: 1 })

    m.wipeEntityRegistry()

    expect(testDb.prepare(`SELECT COUNT(*) AS c FROM entity_defs`).get()).toEqual({ c: 0 })
    expect(testDb.prepare(`SELECT COUNT(*) AS c FROM entity_def_versions`).get()).toEqual({ c: 0 })

    m.saveEntityDefinition({ def: validDef({ id: "after-wipe" }), actor: "u", reason: "" })
    expect(() => testDb.prepare(`DELETE FROM entity_def_versions`).run()).toThrow(/append-only/)
  })
})

describe("resolveScd2Strategy", () => {
  it("returns the bundled mymi-scd2 from _default tenant", async () => {
    const m = await setup()
    const s = m.resolveScd2Strategy("_default", "mymi-scd2")
    expect(s).not.toBeNull()
    expect(s!.id).toBe("mymi-scd2")
    expect(s!.version).toBe(1)
  })

  it("falls back from tenant to _default to bundled", async () => {
    const m = await setup()
    // No 'acme' tenant rows at all; should inherit _default's seeded row.
    const s = m.resolveScd2Strategy("acme", "mymi-scd2")
    expect(s).not.toBeNull()
    expect(s!.identityHandling).toBe("setIdentityInsertOn")
  })

  it("returns tenant override when one exists, not the default", async () => {
    const m = await setup()
    const custom: Scd2Strategy = {
      id: "mymi-scd2",
      displayName: "ACME custom mymi",
      description: "",
      validFromCol: "validFrom",
      validToCol: "validTo",
      isLockedCol: null,
      syncDateCol: null,
      deployDateCol: null,
      identityHandling: "none",
      excludedFromDiffCols: ["validFrom", "validTo"],
      onInsert: { validFrom: "GETUTCDATE()" },
      onUpdate: { validFrom: "GETUTCDATE()" },
      provenance: { kind: "manual" },
      version: 1,
      versionLabel: null,
      createdBy: "acme-admin",
      createdAt: "2026-05-16T00:00:00.000Z"
    }
    m.saveScd2Strategy({ tenantId: "acme", strategy: custom, actor: "acme-admin", reason: "fork" })
    const s = m.resolveScd2Strategy("acme", "mymi-scd2")
    expect(s!.displayName).toBe("ACME custom mymi")
    expect(s!.identityHandling).toBe("none")
    // _default still has the original.
    const def = m.resolveScd2Strategy("_default", "mymi-scd2")
    expect(def!.identityHandling).toBe("setIdentityInsertOn")
  })

  it("returns a specific version when version is a number", async () => {
    const m = await setup()
    const v1 = m.resolveScd2Strategy("_default", "mymi-scd2", 1)
    expect(v1!.version).toBe(1)
    const v99 = m.resolveScd2Strategy("_default", "mymi-scd2", 99)
    expect(v99).toBeNull()
  })

  it("returns null for unknown id", async () => {
    const m = await setup()
    expect(m.resolveScd2Strategy("_default", "nope")).toBeNull()
  })
})

describe("listAvailableStrategies", () => {
  it("for _default tenant returns just the bundled strategies", async () => {
    const m = await setup()
    const ids = m
      .listAvailableStrategies("_default")
      .map((s) => s.id)
      .sort()
    expect(ids).toEqual(BUNDLED_SCD2_STRATEGIES.map((s) => s.id).sort())
  })

  it("for a tenant returns tenant rows + inherited defaults the tenant hasn't shadowed", async () => {
    const m = await setup()
    const custom: Scd2Strategy = {
      id: "acme-custom",
      displayName: "ACME custom",
      description: "",
      validFromCol: "validFrom",
      validToCol: "validTo",
      isLockedCol: null,
      syncDateCol: null,
      deployDateCol: null,
      identityHandling: "none",
      excludedFromDiffCols: ["validFrom", "validTo"],
      onInsert: {},
      onUpdate: {},
      provenance: { kind: "manual" },
      version: 1,
      versionLabel: null,
      createdBy: "u",
      createdAt: "2026-05-16T00:00:00.000Z"
    }
    m.saveScd2Strategy({ tenantId: "acme", strategy: custom, actor: "u", reason: "fork" })
    const ids = m
      .listAvailableStrategies("acme")
      .map((s) => s.id)
      .sort()
    expect(ids).toContain("acme-custom")
    expect(ids).toContain("mymi-scd2") // inherited
    expect(ids).toContain("generic-scd2") // inherited
    expect(ids).toContain("none")
    expect(ids).toContain("audit-cols-only")
  })

  it("tenant rows shadow defaults (no duplicate)", async () => {
    const m = await setup()
    const custom: Scd2Strategy = {
      id: "mymi-scd2",
      displayName: "ACME override",
      description: "",
      validFromCol: "vf",
      validToCol: "vt",
      isLockedCol: null,
      syncDateCol: null,
      deployDateCol: null,
      identityHandling: "none",
      excludedFromDiffCols: ["vf", "vt"],
      onInsert: {},
      onUpdate: {},
      provenance: { kind: "manual" },
      version: 1,
      versionLabel: null,
      createdBy: "u",
      createdAt: "2026-05-16T00:00:00.000Z"
    }
    m.saveScd2Strategy({ tenantId: "acme", strategy: custom, actor: "u", reason: "fork" })
    const matches = m.listAvailableStrategies("acme").filter((s) => s.id === "mymi-scd2")
    expect(matches).toHaveLength(1)
    expect(matches[0]!.displayName).toBe("ACME override")
  })
})

describe("listScd2StrategyHistory", () => {
  it("returns seeded bundled versions for _default tenant", async () => {
    const m = await setup()
    const history = m.listScd2StrategyHistory("_default", "mymi-scd2")
    expect(history).toHaveLength(1)
    expect(history[0]!.version).toBe(1)
    expect(history[0]!.reason).toBeTruthy()
  })

  it("returns append-only versions newest-first after edits", async () => {
    const m = await setup()
    const base = m.resolveScd2Strategy("acme", "generic-scd2")!
    m.saveScd2Strategy({
      tenantId: "acme",
      strategy: { ...base, id: "acme-generic", displayName: "ACME generic v1", provenance: { kind: "manual" } },
      actor: "u",
      reason: "create"
    })
    m.saveScd2Strategy({
      tenantId: "acme",
      strategy: { ...base, id: "acme-generic", displayName: "ACME generic v2", provenance: { kind: "manual" } },
      actor: "u",
      reason: "tweak exclusions"
    })
    const history = m.listScd2StrategyHistory("acme", "acme-generic")
    expect(history.map((h) => h.version)).toEqual([2, 1])
    expect(history[0]!.reason).toBe("tweak exclusions")
  })
})

describe("multi-tenant isolation", () => {
  it("two tenants saving the same id don't collide", async () => {
    const m = await setup()
    m.saveEntityDefinition({
      def: validDef({ tenantId: "acme", displayName: "ACME contract" }),
      actor: "u",
      reason: "",
      tenantId: "acme"
    })
    m.saveEntityDefinition({
      def: validDef({ tenantId: "globex", displayName: "Globex contract" }),
      actor: "u",
      reason: "",
      tenantId: "globex"
    })
    expect(m.getEntityDefinition("acme", "contract")!.displayName).toBe("ACME contract")
    expect(m.getEntityDefinition("globex", "contract")!.displayName).toBe("Globex contract")
  })
})
