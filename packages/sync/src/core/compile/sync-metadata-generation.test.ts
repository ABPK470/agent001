import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

const repoRoot = resolve(import.meta.dirname, "../../../../..")
const syncMetadataSeed = resolve(repoRoot, "deploy/sync/artifacts/sync-metadata.json")
const evidenceFixture = resolve(repoRoot, "deploy/sync/fixtures/legacy-pipeline-evidence.fixture.json")
const pipelineIds = "692,780,788,791,792,798"

describe("sync metadata derivation", () => {
  it("rebuilds sync-metadata.json from legacy pipeline evidence", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "sync-metadata-gen-"))
    const helperPath = new URL("../../../../../deploy/sync/helpers/refresh-from-legacy.mjs", import.meta.url)
      .href
    const { refreshDeployArtifactsFromLegacy } = (await import(helperPath)) as {
      refreshDeployArtifactsFromLegacy: (
        root: string,
        options: {
          evidenceFile: string
          pipelineIds: string
          metadataOnly: boolean
          force: boolean
        },
      ) => Promise<unknown>
    }

    await refreshDeployArtifactsFromLegacy(tempRoot, {
      evidenceFile: evidenceFixture,
      pipelineIds,
      metadataOnly: true,
      force: true,
    })

    const actual = JSON.parse(
      readFileSync(join(tempRoot, "deploy/sync/artifacts/sync-metadata.json"), "utf-8"),
    )
    const expected = JSON.parse(readFileSync(syncMetadataSeed, "utf-8"))
    expect(actual).toEqual(expected)
  })

  it("defines every step type and phase referenced by flows", async () => {
    const modulePath = new URL("../../../../../deploy/sync/helpers/sync-metadata-derivation.mjs", import.meta.url)
      .href
    const { validateSyncMetadataCoversFlows } = (await import(modulePath)) as {
      validateSyncMetadataCoversFlows: (metadata: unknown) => {
        referencedKinds: string[]
        referencedPhases: string[]
      }
    }
    const metadata = JSON.parse(readFileSync(syncMetadataSeed, "utf-8"))
    const coverage = validateSyncMetadataCoversFlows(metadata)

    expect(coverage.referencedKinds).toContain("metadataSync")
    expect(coverage.referencedKinds.length).toBeGreaterThan(10)
    expect(coverage.referencedPhases).toEqual(
      expect.arrayContaining(["preTransaction", "metadata", "postMetadata"]),
    )
  })

  it("gives every step type an executable handler", () => {
    const metadata = JSON.parse(readFileSync(syncMetadataSeed, "utf-8")) as {
      actions: Array<{
        id: string
        definition: {
          handler: {
            type: string
            procedure?: string
            httpService?: string
            httpPath?: string
            sqlBatch?: string
            shellCommand?: string
          }
        }
      }>
    }

    for (const action of metadata.actions) {
      const handler = action.definition.handler
      if (handler.type === "metadata_sync") continue
      if (handler.type === "http_request") {
        expect(handler.httpService, action.id).toBeTruthy()
        expect(handler.httpPath, action.id).toBeTruthy()
        continue
      }
      if (handler.type === "custom_sql") {
        expect(handler.sqlBatch, action.id).toBeTruthy()
        continue
      }
      if (handler.type === "custom_shell_script") {
        expect(handler.shellCommand, action.id).toBeTruthy()
        continue
      }
      expect(handler.procedure, action.id).toBeTruthy()
    }
  })

  it("flow-templates in-memory view matches sync-metadata.flows", async () => {
    const modulePath = new URL("../../../../../deploy/sync/helpers/sync-metadata-derivation.mjs", import.meta.url)
      .href
    const { buildFlowTemplateCatalogFromSyncMetadata } = (await import(modulePath)) as {
      buildFlowTemplateCatalogFromSyncMetadata: (metadata: unknown) => {
        flowTemplates: unknown
      }
    }
    const metadata = JSON.parse(readFileSync(syncMetadataSeed, "utf-8")) as {
      flows: unknown
      _comment?: string
    }
    const flowView = buildFlowTemplateCatalogFromSyncMetadata(metadata)
    expect(flowView.flowTemplates).toEqual(metadata.flows)
  })
})
