import {
  getPublishedSyncDefinitionForHost,
  selectDefinitionTables,
  type PublishedSyncDefinition
} from "@mia/sync"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { configureAgent } from "../src/runtime/runtime.js"

describe("selectDefinitionTables", () => {
  it("keeps FK-only tables disabled unless explicitly enabled", () => {
    const definition = {
      id: "content",
      displayName: "Content",
      rootTable: "gate.Content",
      idColumn: "contentId",
      labelColumn: "name",
      selfJoinColumn: null,
      metadata: {
        tables: [
          {
            name: "gate.Content",
            scopeColumn: "contentId",
            predicate: "contentId = {id}",
            source: "fk+pipeline",
            verified: true,
            groundedByPipeline: true,
            enabledByDefault: true,
            userControllable: false
          },
          {
            name: "gate.UserGroupPermission",
            scopeColumn: null,
            predicate: "EXISTS (...) ",
            source: "fk-only",
            verified: false,
            groundedByPipeline: false,
            enabledByDefault: false,
            userControllable: true
          }
        ],
        executionOrder: ["gate.Content", "gate.UserGroupPermission"],
        reverseOrder: ["gate.UserGroupPermission", "gate.Content"],
        discrepancies: []
      }
    } as PublishedSyncDefinition

    expect(selectDefinitionTables(definition, []).tables.map((table) => table.name)).toEqual([
      "gate.Content"
    ])
    expect(
      selectDefinitionTables(definition, ["gate.UserGroupPermission"]).tables.map((table) => table.name)
    ).toEqual(["gate.Content", "gate.UserGroupPermission"])
  })
})

describe("deployed published sync definitions", () => {
  it("marks gateMetadata FK-only tables as optional and default-off", () => {
    const host = configureAgent({ sync: { project: { dbProjectRoot: resolve(process.cwd(), "../..") } } })
    const definition = getPublishedSyncDefinitionForHost(host, "gateMetadata")
    const optionalTables = definition.metadata.tables.filter((table) => table.userControllable)
    expect(optionalTables.map((table) => table.name)).toEqual([
      "gate.Content",
      "gate.ContentLink",
      "gate.UserGroupPermission"
    ])
    expect(optionalTables.every((table) => table.enabledByDefault === false)).toBe(true)
  })

  it("marks content FK-only tables as optional and default-off", () => {
    const host = configureAgent({ sync: { project: { dbProjectRoot: resolve(process.cwd(), "../..") } } })
    const definition = getPublishedSyncDefinitionForHost(host, "content")
    const optionalTables = definition.metadata.tables.filter((table) => table.userControllable)
    expect(optionalTables.map((table) => table.name)).toEqual(["gate.UserGroupPermission"])
    expect(optionalTables.every((table) => table.enabledByDefault === false)).toBe(true)
  })
})
