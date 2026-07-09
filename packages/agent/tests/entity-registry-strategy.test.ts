/**
 * Entity registry — strategy resolver + bundled strategies tests.
 */

import {
  BUNDLED_SCD2_STRATEGIES,
  bundledStrategyById,
  type EntityTable,
  resolveEffectiveScd2,
  type Scd2Override,
  type Scd2Strategy
} from "@mia/sync"
import { describe, expect, it } from "vitest"

function table(scd2Override: Scd2Override | null = null): EntityTable {
  return {
    name: "core.X",
    scope: { kind: "rootPk", column: "xId" },
    executionOrder: 1,
    scd2Override,
    verified: true,
    archiveTable: null,
    note: null,
    provenance: { kind: "manual" },
    scopeColumn: null,
    source: null,
    groundedByPipeline: null,
    enabledByDefault: null,
    userControllable: null
  }
}

describe("BUNDLED_SCD2_STRATEGIES", () => {
  it("ships four bundled strategies with unique ids", () => {
    const ids = BUNDLED_SCD2_STRATEGIES.map((s) => s.id)
    expect(ids).toEqual(["mymi-scd2", "generic-scd2", "none", "audit-cols-only"])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("mymi-scd2 mirrors the legacy core.uspSyncObjectTran exclusions", () => {
    const s = bundledStrategyById("mymi-scd2")!
    expect(s.excludedFromDiffCols).toEqual(["validFrom", "validTo", "isLocked", "sync-date", "deploy-date"])
    expect(s.identityHandling).toBe("setIdentityInsertOn")
    expect(s.onInsert).toEqual({ validFrom: "GETUTCDATE()", validTo: "NULL" })
  })

  it("none strategy excludes nothing and has empty expressions", () => {
    const s = bundledStrategyById("none")!
    expect(s.excludedFromDiffCols).toEqual([])
    expect(s.onInsert).toEqual({})
    expect(s.onUpdate).toEqual({})
  })

  it("returns undefined for unknown id", () => {
    expect(bundledStrategyById("nope")).toBeUndefined()
  })
})

describe("resolveEffectiveScd2 — no overrides", () => {
  it("returns the strategy verbatim when no overrides", () => {
    const strategy = bundledStrategyById("mymi-scd2")!
    const eff = resolveEffectiveScd2({ strategy, entityOverride: null, table: table() })
    expect(eff.validFromCol).toBe("validFrom")
    expect(eff.identityHandling).toBe("setIdentityInsertOn")
    expect(eff.excludedFromDiffCols).toEqual(strategy.excludedFromDiffCols)
    expect(eff.resolution).toEqual({
      strategyId: "mymi-scd2",
      strategyVersion: 1,
      entityOverrideApplied: false,
      tableOverrideApplied: false
    })
  })
})

describe("resolveEffectiveScd2 — entity-level overrides", () => {
  it("entity override null clears a column", () => {
    const strategy = bundledStrategyById("mymi-scd2")!
    const eff = resolveEffectiveScd2({
      strategy,
      entityOverride: { isLockedCol: null },
      table: table()
    })
    expect(eff.isLockedCol).toBeNull()
    expect(eff.validFromCol).toBe("validFrom") // unchanged
    expect(eff.resolution.entityOverrideApplied).toBe(true)
  })

  it("entity override replaces excludedFromDiffCols (not merged)", () => {
    const strategy = bundledStrategyById("mymi-scd2")!
    const eff = resolveEffectiveScd2({
      strategy,
      entityOverride: { excludedFromDiffCols: ["only_this"] },
      table: table()
    })
    expect(eff.excludedFromDiffCols).toEqual(["only_this"])
  })

  it("entity override changes identityHandling", () => {
    const strategy = bundledStrategyById("mymi-scd2")!
    const eff = resolveEffectiveScd2({
      strategy,
      entityOverride: { identityHandling: "none" },
      table: table()
    })
    expect(eff.identityHandling).toBe("none")
  })

  it("undefined keys fall through", () => {
    const strategy = bundledStrategyById("mymi-scd2")!
    // Explicitly construct an override where keys are absent (not undefined).
    const eff = resolveEffectiveScd2({
      strategy,
      entityOverride: { isLockedCol: null }, // unrelated override
      table: table()
    })
    expect(eff.syncDateCol).toBe("sync-date") // came from strategy
  })
})

describe("resolveEffectiveScd2 — table-level overrides win over entity", () => {
  it("table override beats entity override", () => {
    const strategy = bundledStrategyById("mymi-scd2")!
    const eff = resolveEffectiveScd2({
      strategy,
      entityOverride: { validFromCol: "entity_vf" },
      table: table({ validFromCol: "table_vf" })
    })
    expect(eff.validFromCol).toBe("table_vf")
    expect(eff.resolution.entityOverrideApplied).toBe(true)
    expect(eff.resolution.tableOverrideApplied).toBe(true)
  })

  it("table override null clears strategy value even with entity override set", () => {
    const strategy = bundledStrategyById("mymi-scd2")!
    const eff = resolveEffectiveScd2({
      strategy,
      entityOverride: { validFromCol: "entity_vf" },
      table: table({ validFromCol: null })
    })
    expect(eff.validFromCol).toBeNull()
  })

  it("only table override sets the entity flag false", () => {
    const strategy = bundledStrategyById("mymi-scd2")!
    const eff = resolveEffectiveScd2({
      strategy,
      entityOverride: null,
      table: table({ validFromCol: "table_vf" })
    })
    expect(eff.resolution.entityOverrideApplied).toBe(false)
    expect(eff.resolution.tableOverrideApplied).toBe(true)
  })
})

describe("resolveEffectiveScd2 — dict semantics", () => {
  it("onInsert / onUpdate are REPLACED, not merged", () => {
    const strategy: Scd2Strategy = {
      ...bundledStrategyById("mymi-scd2")!,
      onInsert: { validFrom: "GETUTCDATE()", validTo: "NULL" }
    }
    const eff = resolveEffectiveScd2({
      strategy,
      entityOverride: { onInsert: { validFrom: "@@DBTS" } },
      table: table()
    })
    // validTo dropped because entity override replaces the whole dict.
    expect(eff.onInsert).toEqual({ validFrom: "@@DBTS" })
  })

  it("returned dicts are defensive copies (mutating output does not affect strategy)", () => {
    const strategy = bundledStrategyById("mymi-scd2")!
    const eff = resolveEffectiveScd2({ strategy, entityOverride: null, table: table() })
    eff.onInsert["new"] = "value"
    eff.excludedFromDiffCols.push("polluted")
    expect(strategy.onInsert).not.toHaveProperty("new")
    expect(strategy.excludedFromDiffCols).not.toContain("polluted")
  })
})
