import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { getRecipe, loadSyncRecipes, selectRecipeTables, type SyncRecipe } from "../../sync/src/index.js"
import { configureAgent } from "../src/application/shell/runtime.js"

describe("selectRecipeTables", () => {
  it("keeps FK-only tables disabled unless explicitly enabled", () => {
    const recipe = {
      entityType: "content",
      displayName: "Content",
      rootTable: "gate.Content",
      rootKeyColumn: "contentId",
      rootNameColumn: "name",
      selfJoinColumn: null,
      legacyPipelineId: 692,
      tables: [
        {
          name: "gate.Content",
          scopeColumn: "contentId",
          predicate: "contentId = {id}",
          source: "fk+pipeline",
          verified: true,
          groundedByPipeline: true,
          enabledByDefault: true,
          userControllable: false,
        },
        {
          name: "gate.UserGroupPermission",
          scopeColumn: null,
          predicate: "EXISTS (...) ",
          source: "fk-only",
          verified: false,
          groundedByPipeline: false,
          enabledByDefault: false,
          userControllable: true,
        },
      ],
      executionOrder: ["gate.Content", "gate.UserGroupPermission"],
      reverseOrder: ["gate.UserGroupPermission", "gate.Content"],
      archiveTables: ["gateArchive.Content", "gateArchive.UserGroupPermission"],
      discrepancies: [],
      generatedAt: new Date(0).toISOString(),
    } satisfies SyncRecipe

    expect(selectRecipeTables(recipe, []).tables.map((table) => table.name)).toEqual(["gate.Content"])
    expect(selectRecipeTables(recipe, ["gate.UserGroupPermission"]).tables.map((table) => table.name)).toEqual([
      "gate.Content",
      "gate.UserGroupPermission",
    ])
  })
})

describe("deployed sync recipes", () => {
  it("marks gateMetadata FK-only tables as optional and default-off", () => {
    const host = configureAgent({})
    const bundle = loadSyncRecipes(host, resolve(process.cwd(), "../.."))
    const recipe = getRecipe(bundle, "gateMetadata")
    const optionalTables = recipe.tables.filter((table) => table.userControllable)
    expect(optionalTables.map((table) => table.name)).toEqual([
      "gate.Content",
      "gate.ContentLink",
      "gate.UserGroupPermission",
    ])
    expect(optionalTables.every((table) => table.enabledByDefault === false)).toBe(true)
  })

  it("marks content FK-only tables as optional and default-off", () => {
    const host = configureAgent({})
    const bundle = loadSyncRecipes(host, resolve(process.cwd(), "../.."))
    const recipe = getRecipe(bundle, "content")
    const optionalTables = recipe.tables.filter((table) => table.userControllable)
    expect(optionalTables.map((table) => table.name)).toEqual(["gate.UserGroupPermission"])
    expect(optionalTables.every((table) => table.enabledByDefault === false)).toBe(true)
  })
})