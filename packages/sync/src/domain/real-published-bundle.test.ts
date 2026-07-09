/**
 * Read-only smoke tests against the checked-in definitions.bundle.json.
 * Never writes to sync-definitions/ or any repo config.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import {
  createRepoBundleHost,
  PUBLISHED_BUNDLE_PATH,
  REPO_ROOT,
  requirePublishedBundle
} from "../test-support/repo-bundle.js"
import { selectDefinitionTables } from "./definition-selection.js"
import { getPublishedSyncDefinition, loadPublishedSyncDefinitionBundle } from "./published-definitions.js"

describe("real published bundle (read-only)", () => {
  function stripStepBindings<T extends { bindings?: unknown }>(steps: T[]): Array<Omit<T, "bindings">> {
    return steps.map(({ bindings: _bindings, ...step }) => step)
  }

  it("bundle file exists at the expected repo path", () => {
    requirePublishedBundle()
    expect(PUBLISHED_BUNDLE_PATH).toContain("sync-definitions/published/definitions.bundle.json")
  })

  it("loads core entity definitions from the repo bundle", () => {
    const host = createRepoBundleHost()
    const bundle = loadPublishedSyncDefinitionBundle(host, REPO_ROOT)

    expect(bundle.publishedVersion).toBeTruthy()
    for (const id of ["contract", "dataset", "rule", "content", "pipelineActivity"]) {
      const def = bundle.definitions[id]
      expect(def, `missing definition ${id}`).toBeTruthy()
      expect(def?.executionFlow.catalog?.kinds, `${id} catalog`).toBeTruthy()
    }
  })

  it("contract executionFlow steps match the flow template catalog", () => {
    const host = createRepoBundleHost()
    const contract = getPublishedSyncDefinition(host, REPO_ROOT, "contract")
    const catalog = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "deploy/sync/artifacts/flow-templates.json"), "utf-8")
    ) as { flowTemplates: { contract: { steps: unknown[] } } }

    expect(stripStepBindings(contract.executionFlow.steps)).toEqual(
      stripStepBindings(catalog.flowTemplates.contract.steps)
    )
  })

  it("contract DatasetMapping scopes via datasetId_Left → Dataset, not direct contractId on mapping", () => {
    const host = createRepoBundleHost()
    const contract = getPublishedSyncDefinition(host, REPO_ROOT, "contract")
    const mapping = contract.metadata.tables.find((t) => t.name === "core.DatasetMapping")

    expect(mapping).toBeTruthy()
    expect(mapping?.scopeColumn).toBe("datasetId_Left")
    expect(mapping?.predicate).toMatch(/datasetId_Left/)
    expect(mapping?.predicate).toContain("FROM core.Dataset")
    expect(mapping?.predicate).toContain("contractId = {id}")
    expect(mapping?.predicate).not.toContain("[core].[DatasetMapping].[contractId]")
  })

  it("contract DatasetMappingColumn scopes via datasetMappingId → DatasetMapping → Dataset", () => {
    const host = createRepoBundleHost()
    const contract = getPublishedSyncDefinition(host, REPO_ROOT, "contract")
    const mappingColumn = contract.metadata.tables.find((t) => t.name === "core.DatasetMappingColumn")

    expect(mappingColumn).toBeTruthy()
    expect(mappingColumn?.scopeColumn).toBe("datasetMappingId")
    expect(mappingColumn?.predicate).toContain("[core].[DatasetMappingColumn].[datasetMappingId]")
    expect(mappingColumn?.predicate).toContain("FROM core.DatasetMapping")
    expect(mappingColumn?.predicate).toContain("FROM core.Dataset WHERE contractId = {id}")
    expect(mappingColumn?.predicate).not.toContain("datasetColumnId_Left")
  })

  it("contract excludes FK-only optional tables by default", () => {
    const host = createRepoBundleHost()
    const contract = getPublishedSyncDefinition(host, REPO_ROOT, "contract")
    const defaultSelection = selectDefinitionTables(contract, undefined)
    const names = defaultSelection.tables.map((t) => t.name)

    expect(names).toContain("core.Contract")
    expect(names).toContain("core.DatasetMapping")
    expect(names).not.toContain("core.Step")
    expect(names).not.toContain("core.Rule")
    expect(names).not.toContain("core.RuleColumn")

    const optional = contract.metadata.tables.filter((t) => t.userControllable).map((t) => t.name)
    expect(optional).toEqual(
      expect.arrayContaining([
        "core.Step",
        "core.Rule",
        "core.RuleColumn",
        "core.RuleCondition",
        "core.RuleLink",
        "core.RuleConditionValue"
      ])
    )
  })

  it("contract includes optional tables when explicitly enabled", () => {
    const host = createRepoBundleHost()
    const contract = getPublishedSyncDefinition(host, REPO_ROOT, "contract")
    const withStep = selectDefinitionTables(contract, ["core.Step"])
    expect(withStep.tables.map((t) => t.name)).toContain("core.Step")
    expect(withStep.executionOrder).toContain("core.Step")
  })

  it("dataset definition uses datasetId root and self-join column", () => {
    const host = createRepoBundleHost()
    const dataset = getPublishedSyncDefinition(host, REPO_ROOT, "dataset")

    expect(dataset.rootTable).toBe("core.Dataset")
    expect(dataset.idColumn).toBe("datasetId")
    expect(dataset.selfJoinColumn).toBe("parentDatasetId")
  })

  it("dataset mapping columns scope through dataset mappings, not datasetColumnId_Left", () => {
    const host = createRepoBundleHost()
    const dataset = getPublishedSyncDefinition(host, REPO_ROOT, "dataset")
    const mappingColumn = dataset.metadata.tables.find((t) => t.name === "core.DatasetMappingColumn")

    expect(mappingColumn?.verified).toBe(true)
    expect(mappingColumn?.predicate).toContain("[core].[DatasetMapping] dm")
    expect(mappingColumn?.predicate).toContain("dm.[datasetId_Left] = {id}")
    expect(mappingColumn?.predicate).not.toContain("datasetColumnId_Left")
  })

  it("gate metadata scopes meta columns and json schema through meta views", () => {
    const host = createRepoBundleHost()
    const gateMetadata = getPublishedSyncDefinition(host, REPO_ROOT, "gateMetadata")
    const metaView = gateMetadata.metadata.tables.find((t) => t.name === "gate.MetaView")
    const metaColumn = gateMetadata.metadata.tables.find((t) => t.name === "gate.MetaColumn")
    const jsonSchema = gateMetadata.metadata.tables.find((t) => t.name === "gate.jsonSchema")

    expect(metaView?.verified).toBe(true)
    expect(metaView?.predicate).toBe("tableId = {id}")
    expect(metaColumn?.verified).toBe(true)
    expect(metaColumn?.predicate).toContain("[gate].[MetaView] mv")
    expect(metaColumn?.predicate).toContain("mv.[tableId] = {id}")
    expect(jsonSchema?.verified).toBe(true)
    expect(jsonSchema?.predicate).toContain("[gate].[MetaColumn] mc")
    expect(jsonSchema?.predicate).toContain("mv.[tableId] = {id}")
    expect(jsonSchema?.predicate).not.toContain("review jsonSchemaIds")
  })

  it("content type tables scope through content and content links", () => {
    const host = createRepoBundleHost()
    const content = getPublishedSyncDefinition(host, REPO_ROOT, "content")
    const contentType = content.metadata.tables.find((t) => t.name === "gate.ContentType")
    const contentLinkType = content.metadata.tables.find((t) => t.name === "gate.ContentLinkType")

    expect(contentType?.verified).toBe(true)
    expect(contentType?.predicate).toContain("FROM gate.Content WHERE contentId = {id}")
    expect(contentType?.predicate).toContain("[gate].[ContentType].[contentTypeId]")
    expect(contentLinkType?.verified).toBe(true)
    expect(contentLinkType?.predicate).toContain("FROM gate.ContentLink WHERE contentId = {id}")
    expect(contentLinkType?.predicate).toContain("[gate].[ContentLinkType].[contentLinkTypeId]")
  })

  it("rule scopes the live rule tree instead of only the root rule id", () => {
    const host = createRepoBundleHost()
    const rule = getPublishedSyncDefinition(host, REPO_ROOT, "rule")
    const rootRule = rule.metadata.tables.find((t) => t.name === "core.Rule")
    const dataset = rule.metadata.tables.find((t) => t.name === "core.Dataset")
    const mappingColumn = rule.metadata.tables.find((t) => t.name === "core.DatasetMappingColumn")

    expect(rootRule?.verified).toBe(true)
    expect(rootRule?.predicate).toContain("[core].[fRule]({id})")
    expect(rootRule?.predicate).not.toBe("ruleId = {id}")
    expect(dataset?.verified).toBe(true)
    expect(dataset?.predicate).toContain("inputDatasetId")
    expect(dataset?.predicate).toContain("outputDatasetId")
    expect(mappingColumn?.verified).toBe(true)
    expect(mappingColumn?.predicate).toContain("[core].[DatasetMapping] dm")
    expect(mappingColumn?.predicate).toContain("datasetId_Left")
  })

  it("content optional UserGroupPermission matches published-definitions authority", () => {
    const host = createRepoBundleHost()
    const content = getPublishedSyncDefinition(host, REPO_ROOT, "content")
    const optional = content.metadata.tables.filter((t) => t.userControllable).map((t) => t.name)
    expect(optional).toEqual(["gate.UserGroupPermission"])
  })
})
