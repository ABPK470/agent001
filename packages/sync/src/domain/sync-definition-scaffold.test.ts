import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { loadSyncDefinitionFlowTemplateCatalog } from "./sync-definition-flow-templates.js"
import {
  loadEntityDefinitionsFromDocument,
  scaffoldSyncDefinition,
  selectEntityDefinition
} from "./sync-definition-scaffold.js"

const repoRoot = resolve(import.meta.dirname, "../../../..")
const flowTemplateCatalog = loadSyncDefinitionFlowTemplateCatalog(repoRoot)

interface ScaffoldStep {
  kind: string
}

interface ScaffoldTable {
  name: string
  predicate: string
}

interface ScaffoldDefinition {
  id: string
  bindings: {
    serviceProfileRef: string
    environmentPolicyRef: string
  }
  executionFlow: {
    steps: ScaffoldStep[]
  }
  metadata: {
    executionOrder: string[]
    tables: ScaffoldTable[]
  }
  provenance: {
    kind: string
    sourceArtifact: string
    sourceVersion: number | null
  }
}

describe("sync definition scaffold", () => {
  it("projects entity-registry YAML into the full repo-authored definition shape", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "sync-definition-scaffold-contract-"))
    const yamlPath = join(tempRoot, "contract.yaml")
    writeFileSync(
      yamlPath,
      `id: contract\ntenantId: _default\ndisplayName: Contract\ndescription: Contract entity test fixture\nrootTable: core.Contract\nidColumn: contractId\nlabelColumn: name\nscd2:\n  strategyId: mymi-scd2\n  strategyVersion: latest\ntables:\n  - name: core.ContractColumn\n    scope:\n      kind: rootPk\n      column: contractId\n    executionOrder: 0\n    verified: true\n    scopeColumn: contractId\n    source: fk+pipeline\n    groundedByPipeline: true\n    enabledByDefault: true\n    userControllable: false\n    provenance:\n      kind: legacy-migration\n      legacyPipelineId: 788\n  - name: core.Contract\n    scope:\n      kind: rootPk\n      column: contractId\n    executionOrder: 1\n    verified: true\n    scopeColumn: contractId\n    source: fk+pipeline\n    groundedByPipeline: true\n    enabledByDefault: true\n    userControllable: false\n    provenance:\n      kind: legacy-migration\n      legacyPipelineId: 788\n  - name: core.Pipeline\n    scope:\n      kind: rootPk\n      column: contractId\n    executionOrder: 2\n    verified: true\n    scopeColumn: contractId\n    source: fk+pipeline\n    groundedByPipeline: true\n    enabledByDefault: true\n    userControllable: false\n    provenance:\n      kind: legacy-migration\n      legacyPipelineId: 788\n  - name: core.Step\n    scope:\n      kind: sql\n      predicate: EXISTS (SELECT 1 FROM [core].[Pipeline] p WHERE p.pipelineId = [core].[Step].pipelineId AND p.contractId = {id})\n    executionOrder: 3\n    verified: false\n    source: fk-only\n    groundedByPipeline: false\n    enabledByDefault: false\n    userControllable: true\n    note: Predicate inferred from FK graph. Verify against core.uspSyncCoreObjectsTran body.\n    provenance:\n      kind: legacy-migration\n      legacyPipelineId: 788\npolicies:\n  freezeWindowIds: []\n  riskMultiplier: 1\nprovenance:\n  kind: legacy-migration\n  legacyPipelineId: 788\nlegacyEntrySproc: core.uspSyncCoreObjectsTran\nreverseOrder:\n  - core.Step\n  - core.Pipeline\n  - core.Contract\n  - core.ContractColumn\n`
    )
    const definition = scaffoldSyncDefinition(
      selectEntityDefinition(loadEntityDefinitionsFromDocument(yamlPath), "contract"),
      {
        projectRoot: tempRoot,
        sourceArtifact: yamlPath,
        flowTemplateCatalog
      }
    ) as ScaffoldDefinition

    expect(definition.id).toBe("contract")
    expect(definition.bindings).toEqual({
      serviceProfileRef: "default",
      environmentPolicyRef: "default"
    })
    expect(definition.executionFlow.steps.map((step: ScaffoldStep) => step.kind)).toEqual([
      "auditCheck",
      "targetLock",
      "metadataSync",
      "pipelineRegister",
      "contractUndeploy",
      "targetUnlock",
      "auditCheck",
      "targetLock",
      "contractPreScript",
      "contractCreateStageDataset",
      "contractCreateArchiveDataset",
      "contractCreateListDataset",
      "contractCreateDimDataset",
      "contractCreateFactDataset",
      "contractCreateDatasetFks",
      "contractDeployEtl",
      "contractDeployRoutine",
      "contractPostScript",
      "targetUnlock",
      "syncDate",
      "deployDate"
    ])
    expect(definition.metadata.executionOrder[0]).toBe("core.ContractColumn")
    expect(
      definition.metadata.tables.find((table: ScaffoldTable) => table.name === "core.Step")?.predicate
    ).toContain("EXISTS (SELECT 1")
    expect(definition.provenance.kind).toBe("legacy-migration")
    expect(definition.provenance.sourceArtifact.endsWith("contract.yaml")).toBe(true)
    expect(definition.provenance.sourceVersion).toBeNull()
  })

  it("writes a scaffold file with the metadata-only template for new entities", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "sync-definition-scaffold-"))
    const yamlPath = join(tempRoot, "entity.yaml")
    const outputPath = join(tempRoot, "generated.json")

    writeFileSync(
      yamlPath,
      `id: customThing\ntenantId: _default\ndisplayName: Custom Thing\ndescription: Custom test entity\nrootTable: core.CustomThing\nidColumn: customThingId\nscd2:\n  strategyId: mymi-scd2\n  strategyVersion: latest\ntables:\n  - name: core.CustomThing\n    scope:\n      kind: rootPk\n      column: customThingId\n    executionOrder: 0\n    verified: true\npolicies:\n  freezeWindowIds: []\n  riskMultiplier: 1\nprovenance:\n  kind: manual\n`
    )

    const definition = scaffoldSyncDefinition(
      selectEntityDefinition(loadEntityDefinitionsFromDocument(yamlPath), null),
      {
        projectRoot: tempRoot,
        sourceArtifact: yamlPath,
        flowTemplateId: "metadata-only",
        flowTemplateCatalog
      }
    )
    writeFileSync(outputPath, `${JSON.stringify(definition, null, 2)}\n`)

    const written = JSON.parse(readFileSync(outputPath, "utf-8")) as ScaffoldDefinition

    expect(written.id).toBe("customThing")
    expect(written.executionFlow.steps).toHaveLength(1)
    expect(written.executionFlow.steps[0]?.kind).toBe("metadataSync")
    expect(written.metadata.tables[0]?.predicate).toBe("customThingId = {id}")
  })
})
