import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

const repoRoot = resolve(process.cwd(), "../..")
const scriptPath = resolve(repoRoot, "scripts", "scaffold-sync-definition.mjs")

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

describe("sync definition scaffold command", () => {
  it("projects entity-registry YAML into the full repo-authored definition shape", () => {
    const yamlPath = resolve(repoRoot, "deploy", "mssql", "entities", "_all.yaml")
    const output = execFileSync("node", [scriptPath, "--input", yamlPath, "--entity", "contract"], {
      cwd: repoRoot,
      encoding: "utf-8",
    })

    const definition = JSON.parse(output) as ScaffoldDefinition

    expect(definition.id).toBe("contract")
    expect(definition.bindings).toEqual({
      serviceProfileRef: "default",
      environmentPolicyRef: "default",
    })
    expect(definition.executionFlow.steps.map((step: ScaffoldStep) => step.kind)).toEqual([
      "auditCheck",
      "targetLock",
      "metadataSync",
      "pipelineRegister",
      "contractDeploy",
    ])
    expect(definition.metadata.executionOrder[0]).toBe("core.ContractColumn")
    expect(definition.metadata.tables.find((table: ScaffoldTable) => table.name === "core.Step")?.predicate).toContain("EXISTS (SELECT 1")
    expect(definition.provenance).toEqual({
      kind: "entity-registry-yaml",
      sourceArtifact: "deploy/mssql/entities/_all.yaml",
      sourceVersion: null,
    })
  })

  it("writes a scaffold file with the metadata-only preset for new entities", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "sync-definition-scaffold-"))
    const yamlPath = join(tempRoot, "entity.yaml")
    const outputPath = join(tempRoot, "generated.json")

    writeFileSync(yamlPath, `id: customThing\ntenantId: _default\ndisplayName: Custom Thing\ndescription: Custom test entity\nrootTable: core.CustomThing\nidColumn: customThingId\nscd2:\n  strategyId: mymi-scd2\n  strategyVersion: latest\ntables:\n  - name: core.CustomThing\n    scope:\n      kind: rootPk\n      column: customThingId\n    executionOrder: 0\n    verified: true\npolicies:\n  approvalPolicyId: null\n  freezeWindowIds: []\n  riskMultiplier: 1\nprovenance:\n  kind: manual\n`)

    execFileSync("node", [
      scriptPath,
      "--input", yamlPath,
      "--output", outputPath,
      "--flow-preset", "metadata-only",
      "--write",
    ], {
      cwd: repoRoot,
      encoding: "utf-8",
    })

    const definition = JSON.parse(readFileSync(outputPath, "utf-8")) as ScaffoldDefinition

    expect(definition.id).toBe("customThing")
    expect(definition.executionFlow.steps).toHaveLength(1)
    expect(definition.executionFlow.steps[0]?.kind).toBe("metadataSync")
    expect(definition.metadata.tables[0]?.predicate).toBe("customThingId = {id}")
  })
})