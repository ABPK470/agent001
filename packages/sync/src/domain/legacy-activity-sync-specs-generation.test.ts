import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

const repoRoot = resolve(import.meta.dirname, "../../../..")
const specsSeed = resolve(repoRoot, "deploy/sync/fixtures/legacy-activity-sync-specs.json")
const evidenceFixture = resolve(repoRoot, "deploy/sync/fixtures/legacy-pipeline-evidence.fixture.json")
const syncMetadataSeed = resolve(repoRoot, "deploy/sync/artifacts/sync-metadata.json")

describe("legacy activity sync specs", () => {
  it("buildLegacyActivitySyncSpecs matches committed fixture via direct import", async () => {
    const modulePath = new URL(
      "../../../../deploy/sync/helpers/legacy-activity-sync-specs.mjs",
      import.meta.url
    ).href
    const derivationPath = new URL(
      "../../../../deploy/sync/helpers/sync-metadata-derivation.mjs",
      import.meta.url
    ).href
    const { buildLegacyActivitySyncSpecs } = (await import(modulePath)) as {
      buildLegacyActivitySyncSpecs: (
        evidence: unknown,
        flowCatalog: unknown,
        syncMetadata: unknown
      ) => unknown
    }
    const { buildFlowTemplateCatalogFromSyncMetadata } = (await import(derivationPath)) as {
      buildFlowTemplateCatalogFromSyncMetadata: (metadata: unknown) => unknown
    }

    const evidence = JSON.parse(readFileSync(evidenceFixture, "utf-8"))
    const syncMetadata = JSON.parse(readFileSync(syncMetadataSeed, "utf-8"))
    const flowCatalog = buildFlowTemplateCatalogFromSyncMetadata(syncMetadata)
    const actual = buildLegacyActivitySyncSpecs(evidence, flowCatalog, syncMetadata)
    const expected = JSON.parse(readFileSync(specsSeed, "utf-8"))

    expect(actual).toEqual(expected)
  })

  it("refresh-from-legacy writes matching activity specs in metadata-only mode", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "legacy-refresh-specs-"))
    const helperPath = new URL("../../../../deploy/sync/helpers/refresh-from-legacy.mjs", import.meta.url)
      .href
    const { refreshDeployArtifactsFromLegacy } = (await import(helperPath)) as {
      refreshDeployArtifactsFromLegacy: (
        root: string,
        options: { evidenceFile: string; metadataOnly: boolean; force: boolean }
      ) => Promise<unknown>
    }

    await refreshDeployArtifactsFromLegacy(tempRoot, {
      evidenceFile: resolve(repoRoot, "deploy/sync/fixtures/legacy-pipeline-evidence.fixture.json"),
      metadataOnly: true,
      force: true
    })

    const actual = JSON.parse(
      readFileSync(join(tempRoot, "deploy/sync/fixtures/legacy-activity-sync-specs.json"), "utf-8")
    )
    const expected = JSON.parse(readFileSync(specsSeed, "utf-8"))
    expect(actual).toEqual(expected)
  })

  it("omits activities whose action starts with underscore", async () => {
    const evidencePath = new URL(
      "../../../../deploy/sync/helpers/legacy-pipeline-evidence.mjs",
      import.meta.url
    ).href
    const derivationPath = new URL(
      "../../../../deploy/sync/helpers/sync-metadata-derivation.mjs",
      import.meta.url
    ).href
    const specsPath = new URL(
      "../../../../deploy/sync/helpers/legacy-activity-sync-specs.mjs",
      import.meta.url
    ).href

    const { scopedPipelineActivities, isExcludedPipelineAction, isExcludedPipelineStoredProcedure } =
      (await import(evidencePath)) as {
        scopedPipelineActivities: (activities: unknown[]) => unknown[]
        isExcludedPipelineAction: (action: string) => boolean
        isExcludedPipelineStoredProcedure: (storedProcedure: string | null) => boolean
      }
    const { buildSyncMetadataFromPipelines } = (await import(derivationPath)) as {
      buildSyncMetadataFromPipelines: (pipelines: unknown[], options: unknown) => unknown
    }
    const { buildLegacyActivitySyncSpecs } = (await import(specsPath)) as {
      buildLegacyActivitySyncSpecs: (
        evidence: unknown,
        flowCatalog: unknown,
        syncMetadata: unknown
      ) => { specs: Record<string, unknown> }
    }

    expect(isExcludedPipelineAction("_internal")).toBe(true)
    expect(isExcludedPipelineAction("syncOrNot")).toBe(false)
    expect(isExcludedPipelineAction("")).toBe(false)
    expect(isExcludedPipelineStoredProcedure("core.uspGetPipelineIdForContract")).toBe(true)
    expect(isExcludedPipelineStoredProcedure("core.uspAuditRunCheck")).toBe(false)

    const pipeline = {
      pipelineId: 692,
      name: "Content sync",
      activities: [
        { sequence: 0, activityName: "Internal hook", action: "_onStart", storedProcedure: null },
        {
          sequence: 10,
          activityName: "Synchronize content objects Tran",
          action: "sync",
          storedProcedure: "core.uspSyncContentObjectsTran"
        },
        {
          sequence: 50,
          activityName: "Resolve contract pipeline id",
          action: "sync",
          storedProcedure: "core.uspGetPipelineIdForContract"
        },
        { sequence: 99, activityName: "Handle dependencies", action: "run", storedProcedure: null }
      ]
    }

    const scoped = scopedPipelineActivities(pipeline.activities)
    expect(scoped).toHaveLength(2)
    expect(scoped.map((activity: { activityName: string }) => activity.activityName)).toEqual([
      "Synchronize content objects Tran",
      "Handle dependencies"
    ])

    const baseEvidence = JSON.parse(readFileSync(evidenceFixture, "utf-8"))
    const contentPipeline = baseEvidence.pipelines.find(
      (entry: { pipelineId: number }) => entry.pipelineId === 692
    )
    const syncMetadata = JSON.parse(readFileSync(syncMetadataSeed, "utf-8"))
    const flowCatalog = {
      flowTemplates: {
        content: syncMetadata.flows.content
      }
    }

    const specsFromClean = buildLegacyActivitySyncSpecs(
      { pipelines: [contentPipeline] },
      flowCatalog,
      syncMetadata
    )
    const specsFromNoisy = buildLegacyActivitySyncSpecs({ pipelines: [pipeline] }, flowCatalog, syncMetadata)

    expect(specsFromNoisy.specs).toEqual(specsFromClean.specs)

    const overlay = JSON.parse(readFileSync(specsSeed, "utf-8")).specs
    const metadataFromNoisy = buildSyncMetadataFromPipelines([pipeline], { activitySyncSpecs: overlay })
    const metadataFromClean = buildSyncMetadataFromPipelines([contentPipeline], {
      activitySyncSpecs: overlay
    })
    expect(metadataFromNoisy).toEqual(metadataFromClean)
  })
})
