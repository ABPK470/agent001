import { describe, expect, it } from "vitest"
import { tableScopeSubtitle } from "./entity-overview-helpers"
import type { EntityRegistryTable } from "../../types"

function table(partial: Partial<EntityRegistryTable> & Pick<EntityRegistryTable, "scope">): EntityRegistryTable {
  return {
    name: "gate.Example",
    executionOrder: 1,
    source: "pipeline-only",
    scopeColumn: null,
    archiveTable: null,
    enabledByDefault: true,
    userControllable: false,
    note: null,
    ...partial,
  }
}

describe("tableScopeSubtitle", () => {
  it("shows rootPk column for root scope", () => {
    expect(
      tableScopeSubtitle(
        table({ scope: { kind: "rootPk", column: "contentId" } }),
      ),
    ).toBe("rootPk · contentId")
  })

  it("shows scope column + sql scope label — never raw predicate", () => {
    expect(
      tableScopeSubtitle(
        table({
          scopeColumn: "contentTypeId",
          scope: {
            kind: "sql",
            predicate: "EXISTS (SELECT 1 FROM gate.Content WHERE contentId = {id})",
          },
        }),
      ),
    ).toBe("contentTypeId · sql scope")
  })

  it("falls back to sql scope when no scope column", () => {
    expect(
      tableScopeSubtitle(
        table({
          scope: { kind: "sql", predicate: "contractId = {id}" },
        }),
      ),
    ).toBe("sql scope")
  })
})
