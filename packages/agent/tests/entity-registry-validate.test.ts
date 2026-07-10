/**
 * Entity registry — validation tests.
 *
 * Covers all `ValidationErrorCode`s, scope-discriminator branches, and the
 * SQL-fragment safety guard. Each assertion is a separate `it` so failures
 * point at exactly the rule that broke.
 */

import {
  type EntityDefinition,
  type EntityTable,
  type EntityTableScope,
  type Scd2Strategy,
  compileFkPathPredicate,
  isIdentifier,
  isSchemaQualifiedTable,
  looksUnsafeSqlFragment,
  normalizeEntityDefinition,
  validateEntityDefinition,
  validateScd2Strategy
} from "@mia/sync"
import { describe, expect, it } from "vitest"

// ── Fixture factories ────────────────────────────────────────────

function validTable(overrides: Partial<EntityTable> = {}): EntityTable {
  return {
    name: "core.ContractColumn",
    scope: { kind: "rootPk", column: "contractId" },
    executionOrder: 1,
    scd2Override: null,
    verified: true,
    archiveTable: "coreArchive.ContractColumn",
    note: null,
    provenance: { kind: "manual" },
    scopeColumn: null,
    source: null,
    groundedByPipeline: null,
    enabledByDefault: null,
    userControllable: null,
    ...overrides
  }
}

function validDef(overrides: Partial<EntityDefinition> = {}): EntityDefinition {
  return {
    id: "contract",
    tenantId: "acme",
    displayName: "Contract",
    description: "",
    rootTable: "core.Contract",
    idColumn: "contractId",
    labelColumn: "name",
    selfJoinColumn: null,
    tables: [validTable()],
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
    reason: "initial",
    createdAt: "2026-05-16T00:00:00.000Z",
    retiredAt: null,
    ...overrides
  }
}

function validStrategy(overrides: Partial<Scd2Strategy> = {}): Scd2Strategy {
  return {
    id: "test-strategy",
    displayName: "Test",
    description: "",
    excludeFromDiff: ["validFrom", "validTo"],
    identityHandling: "none",
    onInsert: { validFrom: "GETUTCDATE()" },
    onUpdate: { validFrom: "GETUTCDATE()" },
    provenance: { kind: "manual" },
    version: 1,
    versionLabel: null,
    createdBy: "alice@example.com",
    createdAt: "2026-05-16T00:00:00.000Z",
    ...overrides
  }
}

// ── Identifier helpers ───────────────────────────────────────────

describe("isIdentifier", () => {
  it.each(["contractId", "Contract", "_id", "[Order]", "[Has Spaces]", "ContractColumn123"])(
    "accepts %s",
    (s) => {
      expect(isIdentifier(s)).toBe(true)
    }
  )

  it.each([
    "",
    "1leading",
    "has space",
    "has;semicolon",
    "has--comment",
    "[]",
    "[unterminated",
    "unterminated]",
    "[has]bracket]",
    "[has\nnewline]"
  ])("rejects %s", (s) => {
    expect(isIdentifier(s)).toBe(false)
  })

  it("rejects non-string", () => {
    expect(isIdentifier(123)).toBe(false)
    expect(isIdentifier(null)).toBe(false)
    expect(isIdentifier(undefined)).toBe(false)
  })
})

describe("isSchemaQualifiedTable", () => {
  it.each(["core.Contract", "[Has Space].[Has Space]", "etl.staging_table"])("accepts %s", (s) => {
    expect(isSchemaQualifiedTable(s)).toBe(true)
  })

  it.each(["", "Contract", "a.b.c", "core.", ".Contract", "core .Contract", "core.Con;tract"])(
    "rejects %s",
    (s) => {
      expect(isSchemaQualifiedTable(s)).toBe(false)
    }
  )
})

describe("looksUnsafeSqlFragment", () => {
  it.each([
    "contractId = {id}",
    "datasetMappingId IN (SELECT datasetMappingId FROM core.DM WHERE contractId = {id})",
    "EXISTS (SELECT 1 FROM core.X WHERE X.id = {id} AND X.flag = 1)"
  ])("accepts safe predicate %#", (s) => {
    expect(looksUnsafeSqlFragment(s)).toBe(false)
  })

  it.each([
    "x = 1; DROP TABLE users",
    "x = 1 -- comment",
    "x = 1 /* block */",
    "x = 1\nGO\nDROP TABLE x",
    "x = `id`"
  ])("rejects unsafe predicate %#", (s) => {
    expect(looksUnsafeSqlFragment(s)).toBe(true)
  })
})

// ── EntityDefinition validation ──────────────────────────────────

describe("validateEntityDefinition — id rules", () => {
  it("accepts a baseline valid definition", () => {
    const r = validateEntityDefinition(validDef())
    expect(r.ok).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it("rejects an invalid id", () => {
    const r = validateEntityDefinition(validDef({ id: "1invalid" }))
    expect(r.ok).toBe(false)
    expect(r.errors[0]?.code).toBe("id_invalid")
  })

  it.each(["_internal", "_system", "_meta"])("rejects reserved id %s", (id) => {
    const r = validateEntityDefinition(validDef({ id }))
    expect(r.ok).toBe(false)
    // _internal / _system / _meta fail id_invalid first (regex rejects
    // leading underscore) which is the desired defence-in-depth.
    expect(r.errors[0]?.code).toBe("id_invalid")
  })

  it("rejects empty displayName", () => {
    const r = validateEntityDefinition(validDef({ displayName: "  " }))
    expect(r.ok).toBe(false)
    expect(r.errors[0]?.path).toBe("/displayName")
  })
})

describe("validateEntityDefinition — root rules", () => {
  it("rejects non-schema-qualified rootTable", () => {
    const r = validateEntityDefinition(validDef({ rootTable: "Contract" }))
    expect(r.errors.some((e) => e.code === "root_table_invalid")).toBe(true)
  })

  it("rejects invalid idColumn", () => {
    const r = validateEntityDefinition(validDef({ idColumn: "has space" }))
    expect(r.errors.some((e) => e.code === "id_column_missing")).toBe(true)
  })

  it("accepts null labelColumn", () => {
    const r = validateEntityDefinition(validDef({ labelColumn: null }))
    expect(r.ok).toBe(true)
  })

  it("accepts a self-join column when valid", () => {
    const r = validateEntityDefinition(validDef({ selfJoinColumn: "parentRuleId" }))
    expect(r.ok).toBe(true)
  })

  it("rejects invalid selfJoinColumn", () => {
    const r = validateEntityDefinition(validDef({ selfJoinColumn: "has space" }))
    expect(r.errors.some((e) => e.code === "id_column_missing")).toBe(true)
  })
})

describe("validateEntityDefinition — tables", () => {
  it("warns on empty tables list", () => {
    const r = validateEntityDefinition(validDef({ tables: [] }))
    expect(r.ok).toBe(true)
    expect(r.warnings.some((w) => w.code === "tables_empty")).toBe(true)
  })

  it("rejects duplicate table names", () => {
    const r = validateEntityDefinition(
      validDef({
        tables: [
          validTable({ name: "core.A", executionOrder: 1 }),
          validTable({ name: "core.A", executionOrder: 2 })
        ]
      })
    )
    expect(r.errors.some((e) => e.code === "table_duplicate")).toBe(true)
  })

  it("rejects non-integer executionOrder", () => {
    const r = validateEntityDefinition(validDef({ tables: [validTable({ executionOrder: 1.5 })] }))
    expect(r.errors.some((e) => e.code === "execution_order_duplicate")).toBe(true)
  })

  it("warns on duplicate executionOrder", () => {
    const r = validateEntityDefinition(
      validDef({
        tables: [
          validTable({ name: "core.A", executionOrder: 1 }),
          validTable({ name: "core.B", executionOrder: 1 })
        ]
      })
    )
    expect(r.ok).toBe(true)
    expect(r.warnings.some((w) => w.code === "execution_order_duplicate")).toBe(true)
  })

  it("rejects rootPk scope with invalid column", () => {
    const scope: EntityTableScope = { kind: "rootPk", column: "has space" }
    const r = validateEntityDefinition(validDef({ tables: [validTable({ scope })] }))
    expect(r.errors.some((e) => e.code === "scope_invalid")).toBe(true)
  })

  it("rejects legacy fkPath scope", () => {
    const scope: EntityTableScope = { kind: "fkPath", through: [] }
    const r = validateEntityDefinition(validDef({ tables: [validTable({ scope })] }))
    expect(r.errors.some((e) => e.code === "scope_deprecated")).toBe(true)
  })

  it("normalizes valid multi-hop fkPath to sql", () => {
    const scope: EntityTableScope = {
      kind: "fkPath",
      through: [
        { table: "core.Dataset", fromColumn: "contractId", toColumn: "contractId" },
        { table: "core.DatasetColumn", fromColumn: "datasetId", toColumn: "datasetId" },
      ],
    }
    const def = validDef({
      tables: [
        validTable({
          name: "core.DatasetColumn",
          scope,
        }),
      ],
    })
    const normalized = normalizeEntityDefinition(def)
    expect(normalized.tables[0]?.scope.kind).toBe("sql")
    const r = validateEntityDefinition(normalized)
    expect(r.ok).toBe(true)
  })

  it("rejects sql scope without placeholder", () => {
    const scope: EntityTableScope = { kind: "sql", predicate: "contractId = 1" }
    const r = validateEntityDefinition(validDef({ tables: [validTable({ scope })] }))
    expect(r.errors.some((e) => e.code === "scope_invalid")).toBe(true)
  })

  it("rejects sql scope with unsafe content", () => {
    const scope: EntityTableScope = {
      kind: "sql",
      predicate: "contractId = {id}; DROP TABLE x"
    }
    const r = validateEntityDefinition(validDef({ tables: [validTable({ scope })] }))
    expect(r.errors.some((e) => e.code === "scope_sql_unsafe")).toBe(true)
  })

  it("accepts sql scope referencing {ids} (self-join)", () => {
    const scope: EntityTableScope = {
      kind: "sql",
      predicate: "ruleId IN ({ids})"
    }
    const r = validateEntityDefinition(
      validDef({ selfJoinColumn: "parentRuleId", tables: [validTable({ scope })] })
    )
    expect(r.ok).toBe(true)
  })

  it("rejects table-level SCD2 override with unsafe onInsert", () => {
    const r = validateEntityDefinition(
      validDef({
        tables: [
          validTable({
            scd2Override: { onInsert: { x: "1; DROP TABLE y" } }
          })
        ]
      })
    )
    expect(r.errors.some((e) => e.code === "scope_sql_unsafe")).toBe(true)
  })
})

describe("validateEntityDefinition — SCD2 reference", () => {
  it("rejects unknown strategy id shape", () => {
    const r = validateEntityDefinition(
      validDef({ scd2: { strategyId: "1bad", strategyVersion: 1, entityOverride: null } })
    )
    expect(r.errors.some((e) => e.code === "scd2_strategy_unknown")).toBe(true)
  })

  it("rejects non-positive strategy version", () => {
    const r = validateEntityDefinition(
      validDef({ scd2: { strategyId: "mymi-scd2", strategyVersion: 0, entityOverride: null } })
    )
    expect(r.errors.some((e) => e.code === "scd2_strategy_version_unknown")).toBe(true)
  })

  it("accepts strategyVersion = 'latest'", () => {
    const r = validateEntityDefinition(
      validDef({ scd2: { strategyId: "mymi-scd2", strategyVersion: "latest", entityOverride: null } })
    )
    expect(r.ok).toBe(true)
  })
})

describe("validateEntityDefinition — lineage + version", () => {
  it("rejects non-schema-qualified lineage object", () => {
    const r = validateEntityDefinition(
      validDef({
        lineageRefs: [{ object: "Revenue", kind: "view-source", note: null }]
      })
    )
    expect(r.errors.some((e) => e.code === "lineage_object_invalid")).toBe(true)
  })

  it("rejects version < 1", () => {
    const r = validateEntityDefinition(validDef({ version: 0 }))
    expect(r.errors.some((e) => e.code === "version_not_positive")).toBe(true)
  })
})

// ── Strategy validation ──────────────────────────────────────────

describe("validateScd2Strategy", () => {
  it("accepts a baseline valid strategy", () => {
    expect(validateScd2Strategy(validStrategy()).ok).toBe(true)
  })

  it("rejects invalid id", () => {
    const r = validateScd2Strategy(validStrategy({ id: "1bad" }))
    expect(r.ok).toBe(false)
  })

  it("warns when stamp column is not in excludeFromDiff", () => {
    const r = validateScd2Strategy(validStrategy({ excludeFromDiff: [], onInsert: { validFrom: "GETUTCDATE()" } }))
    expect(r.warnings.some((w) => w.code === "scd2_stamp_not_excluded")).toBe(true)
  })

  it("rejects unsafe onInsert expression", () => {
    const r = validateScd2Strategy(validStrategy({ onInsert: { x: "GETUTCDATE(); DROP TABLE x" } }))
    expect(r.ok).toBe(false)
    expect(r.errors[0]?.code).toBe("scope_sql_unsafe")
  })

  it("accepts hyphenated legacy ABI column names", () => {
    const r = validateScd2Strategy(
      validStrategy({ excludeFromDiff: ["validFrom", "sync-date", "deploy-date"] }),
    )
    expect(r.ok).toBe(true)
  })
})
