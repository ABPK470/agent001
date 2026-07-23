import { describe, expect, it } from "vitest"

import { asFlowId, asStrategyId, asTenantId } from "../../domain/types/branded-ids.js"
import { compileFkPathPredicate, normalizeEntityDefinition } from "./normalize-table-scope.js"
import { projectTablePredicate } from "./project-predicate.js"
import type { EntityTable } from "../../domain/entity-registry/types.js"

describe("normalize-table-scope", () => {
  it("compiles legacy fkPath to sql predicate", () => {
    const entity = {
      selfJoinColumn: null,
      tables: [
        {
          name: "core.TestChild",
          scope: {
            kind: "fkPath" as const,
            through: [{ table: "core.TestChild", fromColumn: "testId", toColumn: "childId" }],
          },
        },
      ],
    }
    const normalized = normalizeEntityDefinition({
      id: "test",
      tenantId: asTenantId("_default"),
      displayName: "Test",
      description: "",
      rootTable: "core.TestRoot",
      idColumn: "testId",
      labelColumn: null,
      selfJoinColumn: null,
      tables: entity.tables as EntityTable[],
      policies: { freezeWindowIds: [] },
      scd2: { strategyId: asStrategyId("mymi-scd2"), strategyVersion: 1, entityOverride: null },
      lineageRefs: [],
      provenance: { kind: "manual" },
      flowId: asFlowId("metadataOnly"),
      legacyEntrySproc: null,
      reverseOrder: [],
      discrepancies: [],
      version: 1,
      versionLabel: null,
      createdBy: "test",
      reason: "test",
      createdAt: new Date(0).toISOString(),
      retiredAt: null,
    })

    expect(normalized.tables[0]?.scope).toEqual({
      kind: "sql",
      predicate: compileFkPathPredicate(entity, "core.TestChild", [
        { table: "core.TestChild", fromColumn: "testId", toColumn: "childId" },
      ]),
    })
    expect(normalized.tables[0]?.scope.kind).toBe("sql")
    if (normalized.tables[0]?.scope.kind === "sql") {
      expect(normalized.tables[0].scope.predicate).toContain("EXISTS")
      expect(projectTablePredicate(normalized, normalized.tables[0]!)).toBe(
        normalized.tables[0].scope.predicate,
      )
    }
  })
})
