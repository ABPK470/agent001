import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { SyncRuntimeHost } from "../ports/host.js"
import { createPublishedSyncDefinitionRegistry } from "./published-definition-registry.js"
import {
  definitionToSyncRecipe,
  getPublishedSyncRecipe,
  loadPublishedSyncDefinitionBundle
} from "./published-definitions.js"

function createHost(projectRoot: string): SyncRuntimeHost {
  return {
    mssql: {
      databases: new Map(),
      defaultConnection: { value: null }
    },
    sync: {
      events: { sink: () => {} },
      runs: {
        sink: {
          start: () => {},
          finish: () => {}
        }
      },
      environments: { items: new Map() },
      plans: { diskRoot: null, memCache: new Map() },
      project: {
        dbProjectRoot: projectRoot,
        publishedDefinitions: createPublishedSyncDefinitionRegistry()
      }
    }
  }
}

const tempRoots: string[] = []

function makeTempProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mia-published-defs-"))
  tempRoots.push(root)
  mkdirSync(join(root, "sync-definitions", "published"), { recursive: true })
  return root
}

function writePublishedBundle(projectRoot: string, bundle: Record<string, unknown>, mtimeMs: number): void {
  const file = join(projectRoot, "sync-definitions", "published", "definitions.bundle.json")
  writeFileSync(file, JSON.stringify(bundle, null, 2))
  const at = new Date(mtimeMs)
  const mt = new Date(mtimeMs)
  utimesSync(file, at, mt)
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe("published sync definition compatibility projection", () => {
  it("projects a published definition into the runtime recipe shape", () => {
    const projectRoot = resolve(process.cwd(), "../..")
    const host = createHost(projectRoot)

    const definitions = loadPublishedSyncDefinitionBundle(host, projectRoot)
    const contractDefinition = definitions.definitions.contract

    expect(contractDefinition).toBeTruthy()
    const recipe = definitionToSyncRecipe(contractDefinition!)
    expect(recipe.generatedAt).toBe(contractDefinition?.publishedAt)
    expect(recipe.rootTable).toBe(contractDefinition?.rootTable)
  })

  it("resolves optional-table semantics from the published definition authority", () => {
    const projectRoot = resolve(process.cwd(), "../..")
    const host = createHost(projectRoot)

    const contentRecipe = getPublishedSyncRecipe(host, "content")
    const gateMetadataRecipe = getPublishedSyncRecipe(host, "gateMetadata")

    expect(contentRecipe.tables.filter((table) => table.userControllable).map((table) => table.name)).toEqual(
      ["gate.UserGroupPermission"]
    )
    expect(
      gateMetadataRecipe.tables.filter((table) => table.userControllable).map((table) => table.name)
    ).toEqual(["gate.Content", "gate.ContentLink", "gate.UserGroupPermission"])
  })

  it("reloads the published bundle when the file changes at runtime", () => {
    const projectRoot = makeTempProjectRoot()
    const host = createHost(projectRoot)
    const firstMtime = Date.UTC(2026, 4, 28, 12, 0, 0)
    const secondMtime = Date.UTC(2026, 4, 28, 12, 0, 1)

    writePublishedBundle(
      projectRoot,
      {
        version: 1,
        publishedAt: "2026-05-28T12:00:00.000Z",
        publishedVersion: "v1",
        definitions: {
          contract: {
            schemaVersion: 1,
            id: "contract",
            displayName: "Contract V1",
            description: "First",
            rootTable: "core.Contract",
            idColumn: "contractId",
            labelColumn: "name",
            selfJoinColumn: null,
            legacy: { pipelineId: null, entrySproc: null },
            governance: { freezeWindowIds: [], riskMultiplier: 1 },
            strategy: { strategyId: "mymi-scd2", strategyVersion: 1 },
            bindings: { serviceProfileRef: "default", environmentPolicyRef: "default" },
            ownership: { team: "sync-platform", owner: null, reviewStatus: "reviewed", notes: [] },
            metadata: { tables: [], executionOrder: [], reverseOrder: [], discrepancies: [] },
            executionFlow: { steps: [] },
            provenance: { kind: "manual", sourceArtifact: "test", sourceVersion: "v1" },
            publishedAt: "2026-05-28T12:00:00.000Z",
            publishedVersion: "v1"
          }
        }
      },
      firstMtime
    )

    const first = loadPublishedSyncDefinitionBundle(host, projectRoot)
    expect(first.publishedVersion).toBe("v1")
    expect(first.definitions.contract?.displayName).toBe("Contract V1")

    writePublishedBundle(
      projectRoot,
      {
        version: 1,
        publishedAt: "2026-05-28T12:00:01.000Z",
        publishedVersion: "v2-runtime",
        definitions: {
          contract: {
            schemaVersion: 1,
            id: "contract",
            displayName: "Contract V2 Runtime",
            description: "Second runtime load",
            rootTable: "core.Contract",
            idColumn: "contractId",
            labelColumn: "name",
            selfJoinColumn: null,
            legacy: { pipelineId: null, entrySproc: null },
            governance: { freezeWindowIds: [], riskMultiplier: 1 },
            strategy: { strategyId: "mymi-scd2", strategyVersion: 1 },
            bindings: { serviceProfileRef: "default", environmentPolicyRef: "default" },
            ownership: { team: "sync-platform", owner: null, reviewStatus: "reviewed", notes: ["runtime"] },
            metadata: { tables: [], executionOrder: [], reverseOrder: [], discrepancies: [] },
            executionFlow: { steps: [] },
            provenance: { kind: "manual", sourceArtifact: "test", sourceVersion: "v2" },
            publishedAt: "2026-05-28T12:00:01.000Z",
            publishedVersion: "v2-runtime"
          }
        }
      },
      secondMtime
    )

    const second = loadPublishedSyncDefinitionBundle(host, projectRoot)
    expect(second.publishedVersion).toBe("v2-runtime")
    expect(second.definitions.contract?.displayName).toBe("Contract V2 Runtime")
  })
})
