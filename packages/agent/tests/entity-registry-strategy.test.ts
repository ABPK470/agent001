/**
 * Entity registry — strategy resolver + bundled strategies tests.
 */

import { resolve } from "node:path"

import {
  shippedScd2Strategies,
  shippedStrategyById,
  type EntityTable,
  resolveEffectiveScd2,
  type Scd2Override,
  type Scd2Strategy,
  validateScd2Strategy,
} from "@mia/sync"
import { describe, expect, it } from "vitest"

const repoRoot = resolve(import.meta.dirname, "../../..")
const shippedStrategies = shippedScd2Strategies(repoRoot)

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
    userControllable: null,
  }
}

describe("shipped SCD2 strategies artifact", () => {
  it("ships four bundled strategies with unique ids", () => {
    const ids = shippedStrategies.map((s) => s.id)
    expect(ids).toEqual(["mymi-scd2", "generic-scd2", "none", "audit-cols-only"])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("mymi-scd2 mirrors the legacy core.uspSyncObjectTran exclusions", () => {
    const s = shippedStrategyById(repoRoot, "mymi-scd2")!
    expect(s.excludeFromDiff).toEqual(["validFrom", "validTo", "isLocked", "sync-date", "deploy-date"])
    expect(s.identityHandling).toBe("setIdentityInsertOn")
    expect(s.onInsert).toEqual({ validFrom: "GETUTCDATE()", validTo: "NULL" })
  })

  it("none strategy excludes nothing and has empty expressions", () => {
    const s = shippedStrategyById(repoRoot, "none")!
    expect(s.excludeFromDiff).toEqual([])
    expect(s.onInsert).toEqual({})
    expect(s.onUpdate).toEqual({})
  })

  it("mymi-scd2 passes validation including hyphenated column names", () => {
    const s = shippedStrategyById(repoRoot, "mymi-scd2")!
    expect(validateScd2Strategy(s).ok).toBe(true)
  })

  it("returns undefined for unknown id", () => {
    expect(shippedStrategyById(repoRoot, "nope")).toBeUndefined()
  })
})

describe("resolveEffectiveScd2 — no overrides", () => {
  it("returns the strategy verbatim when no overrides", () => {
    const strategy = shippedStrategyById(repoRoot, "mymi-scd2")!
    const eff = resolveEffectiveScd2({ strategy, entityOverride: null, table: table() })
    expect(eff.excludeFromDiff).toEqual(strategy.excludeFromDiff)
    expect(eff.identityHandling).toBe("setIdentityInsertOn")
    expect(eff.onInsert).toEqual(strategy.onInsert)
    expect(eff.resolution).toEqual({
      strategyId: "mymi-scd2",
      strategyVersion: 1,
      entityOverrideApplied: false,
      tableOverrideApplied: false,
    })
  })
})

describe("resolveEffectiveScd2 — entity-level overrides", () => {
  it("entity override replaces excludeFromDiff (not merged)", () => {
    const strategy = shippedStrategyById(repoRoot, "mymi-scd2")!
    const eff = resolveEffectiveScd2({
      strategy,
      entityOverride: { excludeFromDiff: ["only_this"] },
      table: table(),
    })
    expect(eff.excludeFromDiff).toEqual(["only_this"])
  })

  it("entity override changes identityHandling", () => {
    const strategy = shippedStrategyById(repoRoot, "mymi-scd2")!
    const eff = resolveEffectiveScd2({
      strategy,
      entityOverride: { identityHandling: "none" },
      table: table(),
    })
    expect(eff.identityHandling).toBe("none")
  })
})

describe("resolveEffectiveScd2 — table-level overrides win over entity", () => {
  it("table override beats entity override", () => {
    const strategy = shippedStrategyById(repoRoot, "mymi-scd2")!
    const eff = resolveEffectiveScd2({
      strategy,
      entityOverride: { excludeFromDiff: ["entity_col"] },
      table: table({ excludeFromDiff: ["table_col"] }),
    })
    expect(eff.excludeFromDiff).toEqual(["table_col"])
    expect(eff.resolution.entityOverrideApplied).toBe(true)
    expect(eff.resolution.tableOverrideApplied).toBe(true)
  })

  it("only table override sets the entity flag false", () => {
    const strategy = shippedStrategyById(repoRoot, "mymi-scd2")!
    const eff = resolveEffectiveScd2({
      strategy,
      entityOverride: null,
      table: table({ excludeFromDiff: ["table_col"] }),
    })
    expect(eff.resolution.entityOverrideApplied).toBe(false)
    expect(eff.resolution.tableOverrideApplied).toBe(true)
  })
})

describe("resolveEffectiveScd2 — dict semantics", () => {
  it("onInsert / onUpdate are REPLACED, not merged", () => {
    const strategy: Scd2Strategy = {
      ...shippedStrategyById(repoRoot, "mymi-scd2")!,
      onInsert: { validFrom: "GETUTCDATE()", validTo: "NULL" },
    }
    const eff = resolveEffectiveScd2({
      strategy,
      entityOverride: { onInsert: { validFrom: "@@DBTS" } },
      table: table(),
    })
    expect(eff.onInsert).toEqual({ validFrom: "@@DBTS" })
  })

  it("returned dicts are defensive copies (mutating output does not affect strategy)", () => {
    const strategy = shippedStrategyById(repoRoot, "mymi-scd2")!
    const eff = resolveEffectiveScd2({ strategy, entityOverride: null, table: table() })
    eff.onInsert["new"] = "value"
    eff.excludeFromDiff.push("polluted")
    expect(strategy.onInsert).not.toHaveProperty("new")
    expect(strategy.excludeFromDiff).not.toContain("polluted")
  })
})

describe("resolveEffectiveScd2 — legacy strategy normalization", () => {
  it("merges legacy role columns into excludeFromDiff", () => {
    const base = shippedStrategyById(repoRoot, "none")!
    const legacy = {
      ...base,
      excludeFromDiff: undefined as unknown as string[],
      validFromCol: "validFrom",
      validToCol: "validTo",
      isLockedCol: "isLocked",
      excludedFromDiffCols: ["sync-date"],
    } as Scd2Strategy & {
      validFromCol: string
      validToCol: string
      isLockedCol: string
      excludedFromDiffCols: string[]
      excludeFromDiff?: string[]
    }
    const eff = resolveEffectiveScd2({ strategy: legacy, entityOverride: null, table: table() })
    expect(eff.excludeFromDiff).toEqual(
      expect.arrayContaining(["validFrom", "validTo", "isLocked", "sync-date"]),
    )
  })
})
