/**
 * Sync tools — dynamic entity type resolution from published definitions.
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  createPublishedSyncDefinitionRegistry,
  createSyncPreviewTool,
  listPublishedSyncDefinitionIds,
  type SyncRuntimeHost
} from "@mia/sync"

const tempRoots: string[] = []

function createHost(projectRoot: string): SyncRuntimeHost {
  return {
    mssql: { databases: new Map(), defaultConnection: { value: null } },
    sync: {
      events: { sink: () => {} },
      runs: { sink: { start: () => {}, finish: () => {} }, actorUpn: null },
      governance: { freezeWindowsReader: () => [] },
      environments: {
        items: new Map([
          [
            "dev",
            {
              name: "dev",
              displayName: "Dev",
              color: "emerald",
              role: "both",
              ringOrder: 0,
              allowedSyncTargets: null,
              accessMode: "read_write",
              allowedOperations: null
            }
          ]
        ])
      },
      plans: { diskRoot: null, memCache: new Map() },
      project: { dbProjectRoot: projectRoot, publishedDefinitions: createPublishedSyncDefinitionRegistry() }
    }
  } as unknown as SyncRuntimeHost
}

function writeBundle(projectRoot: string, entityIds: string[]): void {
  const definitions = Object.fromEntries(
    entityIds.map((id) => [
      id,
      {
        schemaVersion: 1,
        id,
        displayName: id,
        description: "test",
        rootTable: "core.Test",
        idColumn: "testId",
        labelColumn: null,
        selfJoinColumn: null,
        legacy: { pipelineId: null, entrySproc: null },
        governance: { freezeWindowIds: [] },
        strategy: { strategyId: "mymi-scd2", strategyVersion: 1 },
        bindings: { serviceProfileRef: "default", environmentPolicyRef: "default" },
        ownership: { team: "test", owner: null, reviewStatus: "reviewed", notes: [] },
        metadata: {
          tables: [
            {
              name: "core.Test",
              scopeColumn: "testId",
              predicate: "testId = {id}",
              source: "manual",
              verified: true,
              groundedByPipeline: false,
              enabledByDefault: true,
              userControllable: false
            }
          ],
          executionOrder: ["core.Test"],
          reverseOrder: ["core.Test"],
          discrepancies: []
        },
        executionFlow: { steps: [] },
        provenance: { kind: "manual", sourceArtifact: "test", sourceVersion: "1" },
        publishedAt: "2026-01-01T00:00:00.000Z",
        publishedVersion: "v1"
      }
    ])
  )
  const file = join(projectRoot, "sync-definitions", "published", "definitions.bundle.json")
  writeFileSync(
    file,
    JSON.stringify({ version: 1, publishedAt: "2026-01-01", publishedVersion: "v1", definitions }, null, 2)
  )
  const now = Date.now()
  utimesSync(file, new Date(now), new Date(now))
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe("sync tools entity types", () => {
  it("listPublishedSyncDefinitionIds returns bundle keys", () => {
    const root = mkdtempSync(join(tmpdir(), "sync-tools-ids-"))
    tempRoots.push(root)
    mkdirSync(join(root, "sync-definitions", "published"), { recursive: true })
    writeBundle(root, ["contract", "myCustomEntity"])

    const host = createHost(root)
    expect(listPublishedSyncDefinitionIds(host).sort()).toEqual(["contract", "myCustomEntity"])
  })

  it("sync_preview accepts a custom entity id from the published bundle", async () => {
    const root = mkdtempSync(join(tmpdir(), "sync-tools-preview-"))
    tempRoots.push(root)
    mkdirSync(join(root, "sync-definitions", "published"), { recursive: true })
    writeBundle(root, ["myCustomEntity"])

    const host = createHost(root)
    const tool = createSyncPreviewTool(host)
    const result = await tool.execute({
      entityType: "myCustomEntity",
      entityId: 42,
      source: "dev",
      target: "dev"
    })

    expect(String(result)).not.toMatch(/invalid entityType/i)
  })

  it("sync_preview rejects entity ids not in the published bundle", async () => {
    const root = mkdtempSync(join(tmpdir(), "sync-tools-reject-"))
    tempRoots.push(root)
    mkdirSync(join(root, "sync-definitions", "published"), { recursive: true })
    writeBundle(root, ["contract"])

    const host = createHost(root)
    const tool = createSyncPreviewTool(host)
    const result = await tool.execute({
      entityType: "notPublished",
      entityId: 1,
      source: "dev",
      target: "dev"
    })

    expect(String(result)).toMatch(/invalid entityType|No published sync definition/i)
  })
})
