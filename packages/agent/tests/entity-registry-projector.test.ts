/**
 * Entity-registry projector tests — Phase 0 sanity coverage.
 *
 * Covers the three scope kinds (`rootPk`, `fkPath`, `sql`), archive-table
 * derivation, execution-order sorting, and the `projectedFrom` lineage
 * envelope. Strategy resolution is exercised indirectly through the
 * `effectiveScd2[]` parallel array.
 */

import { describe, expect, it } from "vitest"
import { projectRecipe } from "../src/sync/entity-registry/projector.js"
import type {
    EntityDefinition,
    EntityTable,
    Scd2Strategy,
} from "../src/sync/entity-registry/types.js"

const STRATEGY: Scd2Strategy = {
  id:                "mymi-scd2",
  displayName:       "MyMI SCD2",
  description:       "MyMI conventions",
  validFromCol:      "ValidFromDate",
  validToCol:        "ValidToDate",
  isLockedCol:       "IsLocked",
  syncDateCol:       "SyncDate",
  deployDateCol:     "DeployDate",
  identityHandling:  "setIdentityInsertOn",
  excludedFromDiffCols: ["SyncDate", "DeployDate"],
  onInsert:          { ValidFromDate: "GETUTCDATE()" },
  onUpdate:          { ValidToDate:   "GETUTCDATE()" },
  provenance:        { kind: "bundled", templateId: "mymi-scd2" },
  version:           1,
  versionLabel:      null,
  createdBy:         "boot:bundled",
  createdAt:         "2025-01-01T00:00:00.000Z",
}

function tbl(over: Partial<EntityTable> & Pick<EntityTable, "name" | "scope" | "executionOrder">): EntityTable {
  return {
    scd2Override: null,
    verified:     true,
    archiveTable: null,
    note:         null,
    provenance:   { kind: "manual" },
    scopeColumn: null,
    source: null,
    groundedByPipeline: null,
    enabledByDefault: null,
    userControllable: null,
    ...over,
  }
}

function makeDef(over: Partial<EntityDefinition> = {}): EntityDefinition {
  return {
    id:             "contract",
    tenantId:       "_default",
    displayName:    "Contract",
    description:    "",
    rootTable:      "dbo.Contract",
    idColumn:       "ContractId",
    labelColumn:    "Title",
    selfJoinColumn: null,
    tables: [
      tbl({ name: "dbo.Contract", executionOrder: 1, scope: { kind: "rootPk", column: "ContractId" }, archiveTable: "dboArchive.Contract" }),
    ],
    policies:       { approvalPolicyId: null, freezeWindowIds: [], riskMultiplier: 1.0 },
    scd2:           { strategyId: "mymi-scd2", strategyVersion: 1, entityOverride: null },
    lineageRefs:    [],
    provenance:     { kind: "manual" },
    legacyEntrySproc: null,
    reverseOrder: [],
    discrepancies: [],
    version:        1,
    versionLabel:   null,
    createdBy:      "test",
    reason:         "test",
    createdAt:      "2025-01-01T00:00:00.000Z",
    retiredAt:      null,
    ...over,
  }
}

describe("projectRecipe", () => {
  it("projects a rootPk scope to a `= {id}` predicate (no self-join)", () => {
    const recipe = projectRecipe({
      def:         makeDef(),
      strategy:    STRATEGY,
      generatedAt: "2025-11-01T00:00:00.000Z",
    })
    expect(recipe.tables).toHaveLength(1)
    expect(recipe.tables[0]!.predicate).toBe("ContractId = {id}")
    expect(recipe.tables[0]!.scopeColumn).toBe("ContractId")
    expect(recipe.archiveTables).toEqual(["dboArchive.Contract"])
    expect(recipe.executionOrder).toEqual(["dbo.Contract"])
    expect(recipe.reverseOrder).toEqual(["dbo.Contract"])
    expect(recipe.generatedAt).toBe("2025-11-01T00:00:00.000Z")
  })

  it("uses `IN ({ids})` when the entity has a self-join column", () => {
    const recipe = projectRecipe({
      def:      makeDef({ selfJoinColumn: "ParentContractId" }),
      strategy: STRATEGY,
    })
    expect(recipe.tables[0]!.predicate).toBe("ContractId IN ({ids})")
    expect(recipe.selfJoinColumn).toBe("ParentContractId")
  })

  it("projects an fkPath scope to an EXISTS chain with aliased hops", () => {
    const def = makeDef({
      tables: [
        tbl({ name: "dbo.Contract", executionOrder: 1, scope: { kind: "rootPk", column: "ContractId" } }),
        tbl({
          name: "dbo.ContractLineItem", executionOrder: 2,
          scope: {
            kind: "fkPath",
            through: [
              { table: "dbo.ContractLineItem", fromColumn: "ContractId", toColumn: "ContractLineItemId" },
            ],
          },
        }),
      ],
    })
    const recipe = projectRecipe({ def, strategy: STRATEGY })
    expect(recipe.tables[1]!.predicate).toContain("EXISTS")
    expect(recipe.tables[1]!.predicate).toContain("h0")
  })

  it("passes through a verbatim sql predicate", () => {
    const def = makeDef({
      tables: [
        tbl({
          name: "dbo.Contract", executionOrder: 1,
          scope: { kind: "sql", predicate: "ContractId = {id} AND IsActive = 1" },
        }),
      ],
    })
    const recipe = projectRecipe({ def, strategy: STRATEGY })
    expect(recipe.tables[0]!.predicate).toBe("ContractId = {id} AND IsActive = 1")
    expect(recipe.tables[0]!.scopeColumn).toBeNull()
  })

  it("sorts tables by executionOrder (idx tie-break) and reverses for delete", () => {
    const def = makeDef({
      tables: [
        tbl({ name: "dbo.B", executionOrder: 2, scope: { kind: "rootPk", column: "Id" } }),
        tbl({ name: "dbo.A", executionOrder: 1, scope: { kind: "rootPk", column: "Id" } }),
        tbl({ name: "dbo.C", executionOrder: 2, scope: { kind: "rootPk", column: "Id" } }), // tie with B; idx breaks
      ],
    })
    const recipe = projectRecipe({ def, strategy: STRATEGY })
    expect(recipe.executionOrder).toEqual(["dbo.A", "dbo.B", "dbo.C"])
    expect(recipe.reverseOrder).toEqual(["dbo.C", "dbo.B", "dbo.A"])
  })

  it("derives archive table by `{schema}Archive.{name}` when not specified", () => {
    const def = makeDef({
      tables: [
        tbl({ name: "core.Foo", executionOrder: 1, scope: { kind: "rootPk", column: "Id" } }),
      ],
    })
    const recipe = projectRecipe({ def, strategy: STRATEGY })
    expect(recipe.archiveTables).toEqual(["coreArchive.Foo"])
  })

  it("stamps projectedFrom with versions for forensic replay", () => {
    const recipe = projectRecipe({ def: makeDef({ version: 7 }), strategy: { ...STRATEGY, version: 3 } })
    expect(recipe.projectedFrom).toEqual({
      tenantId:        "_default",
      entityId:        "contract",
      entityVersion:   7,
      strategyId:      "mymi-scd2",
      strategyVersion: 3,
    })
  })

  it("emits effectiveScd2[] in parallel with tables[]", () => {
    const def = makeDef({
      tables: [
        tbl({ name: "dbo.A", executionOrder: 1, scope: { kind: "rootPk", column: "Id" } }),
        tbl({ name: "dbo.B", executionOrder: 2, scope: { kind: "rootPk", column: "Id" } }),
      ],
    })
    const recipe = projectRecipe({ def, strategy: STRATEGY })
    expect(recipe.effectiveScd2).toHaveLength(2)
    expect(recipe.effectiveScd2[0]!.validFromCol).toBe("ValidFromDate")
  })

  it("marks unverified tables as 'implicit' discrepancies", () => {
    const def = makeDef({
      tables: [
        tbl({ name: "dbo.A", executionOrder: 1, scope: { kind: "rootPk", column: "Id" }, verified: false }),
      ],
    })
    const recipe = projectRecipe({ def, strategy: STRATEGY })
    expect(recipe.discrepancies.length).toBeGreaterThan(0)
  })
})
