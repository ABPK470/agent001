/**
 * Agent sync_preview must refuse when publish readiness says tip is ahead —
 * same gate as HTTP /api/sync/preview (hosted in previewSync).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  createPublishedSyncDefinitionRegistry,
  createSyncPreviewTool,
  PUBLISH_REQUIRED_CODE,
  type SyncRuntimeHost,
} from "../index.js"

const tempRoots: string[] = []

afterEach(() => {
  while (tempRoots.length) {
    const root = tempRoots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

function writeMinimalBundle(projectRoot: string, entityId: string): void {
  mkdirSync(join(projectRoot, "sync-definitions", "published"), { recursive: true })
  const def = {
    id: entityId,
    displayName: entityId,
    rootTable: "dbo.T",
    idColumn: "id",
    publishedAt: "2026-01-01T00:00:00.000Z",
    publishedVersion: "v1",
    governance: { freezeWindowIds: [] },
    metadata: { tables: [] },
    executionFlow: { steps: [], catalog: { version: 1, kinds: {}, flows: {}, actions: {}, valueSources: {}, phases: {} } },
  }
  writeFileSync(
    join(projectRoot, "sync-definitions", "published", "definitions.bundle.json"),
    JSON.stringify({
      version: 1,
      publishedAt: "2026-01-01",
      publishedVersion: "v1",
      definitions: { [entityId]: def },
    }),
  )
}

function createHost(
  projectRoot: string,
  entityNeedsRepublish: (id: string) => boolean,
): SyncRuntimeHost {
  return {
    mssql: { databases: new Map(), defaultConnection: { value: null } },
    sync: {
      events: { sink: () => {} },
      runs: {
        sink: { start: () => {}, finish: () => {}, savePlan: () => {}, loadPlan: () => null },
        actorUpn: null,
      },
      governance: { freezeWindowsReader: () => [] },
      environments: { items: new Map() },
      plans: { diskRoot: null, memCache: new Map() },
      project: {
        dbProjectRoot: projectRoot,
        publishedDefinitions: createPublishedSyncDefinitionRegistry(),
        publishReadiness: { entityNeedsRepublish },
      },
    },
  } as unknown as SyncRuntimeHost
}

describe("sync_preview publish gate", () => {
  it("returns publish_required when host says entity tip is ahead", async () => {
    const root = mkdtempSync(join(tmpdir(), "mia-publish-gate-"))
    tempRoots.push(root)
    writeMinimalBundle(root, "contract")
    const tool = createSyncPreviewTool(createHost(root, () => true))
    const result = await tool.execute({
      entityType: "contract",
      entityId: 1,
      source: "DEV",
      target: "UAT",
    })
    expect(String(result)).toContain(PUBLISH_REQUIRED_CODE)
    expect(String(result)).toMatch(/Publish from Entity Registry/)
  })
})
