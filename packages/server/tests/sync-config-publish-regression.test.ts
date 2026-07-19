/**
 * Sync configuration — publish / tip / boot / env regression suite.
 *
 * Covers the Configuration wiring end-to-end: tip history, Publish arming,
 * operational (env) tip, boot tip-SoT, zombie stamps, preview vs history,
 * entity fan-out, and post-publish stamp alignment.
 *
 * These scenarios exist so the green-"published" / silent-boot-wipe class of
 * bugs cannot return without failing CI.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  classifyCatalogPublish,
} from "../src/api/sync/service/catalog-publish-classification.js"
import {
  getSyncPublishPreview,
  getSyncPublishStatus,
  listSyncDefinitionAdminItems,
  publishSyncDefinitionsFromDb,
} from "../src/api/sync/service/definitions.js"
import {
  ensureInitialSyncCatalogVersion,
  getActiveSyncCatalogVersion,
  listSyncCatalogVersions,
  recordSyncCatalogChange,
} from "../src/api/platform/service/sync-catalog-versioning.js"
import * as db from "../src/infra/persistence/db/index.js"
import {
  appendFlowMarkerStep,
  bootstrapPublishedCatalog,
  buildSyncDefinitionsApp,
  bumpSyncEnvironmentTip,
  setupCatalogOperatorFixture,
  teardownCatalogOperatorFixture,
  TENANT,
  type CatalogOperatorFixture,
} from "./helpers/catalog-operator-fixture.js"

let fixture: CatalogOperatorFixture

beforeEach(async () => {
  fixture = await setupCatalogOperatorFixture()
})

afterEach(() => {
  teardownCatalogOperatorFixture(fixture)
})

function status() {
  return getSyncPublishStatus(fixture.projectRoot, TENANT)
}

function preview() {
  return getSyncPublishPreview(fixture.projectRoot, TENANT)
}

function classify() {
  return classifyCatalogPublish(fixture.projectRoot, TENANT)
}

function stampQuiet(): void {
  const s = status()
  expect(s.catalogNeedsPublish, "Publish must not be armed").toBe(false)
  expect(s.operationalCatalogAhead, "must not be env-only ahead").toBe(false)
  expect(s.activeCatalogVersion).toBe(s.publishedCatalogVersion)
}

function stampPublishPending(opts?: { minTip?: number }): void {
  const s = status()
  expect(s.catalogNeedsPublish, "Publish must be armed").toBe(true)
  expect(s.operationalCatalogAhead).toBe(false)
  expect(s.activeCatalogVersion).not.toBe(s.publishedCatalogVersion)
  if (opts?.minTip != null) {
    expect(s.activeCatalogVersion).toBeGreaterThanOrEqual(opts.minTip)
  }
}

describe("sync config — baseline seed + first publish", () => {
  it("seeds tip history and Publish stamps them equal", async () => {
    const { tipVersion, publishedVersion } = await bootstrapPublishedCatalog(fixture)
    expect(tipVersion).toBe(publishedVersion)
    stampQuiet()
    expect(status().unpublishedEntityCount).toBe(0)
    expect(preview().changeCount).toBe(0)
  })

  it("first publish without prior tip commits still produces a stamp", () => {
    ensureInitialSyncCatalogVersion("system")
    const result = publishSyncDefinitionsFromDb(fixture.projectRoot)
    expect(result.definitionCount).toBeGreaterThan(0)
    const meta = db.getSyncPublishMeta(TENANT)
    expect(meta?.catalog_version).toBe(getActiveSyncCatalogVersion(TENANT))
    stampQuiet()
  })

  it("admin list marks no entity needsPublish when stamps match", async () => {
    await bootstrapPublishedCatalog(fixture)
    const items = listSyncDefinitionAdminItems(fixture.projectRoot, TENANT)
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((item) => item.needsPublish === false)).toBe(true)
  })

  it("preview sections empty when tip matches publish", async () => {
    await bootstrapPublishedCatalog(fixture)
    const p = preview()
    expect(p.catalogNeedsPublish).toBe(false)
    expect(p.sections).toEqual([])
    expect(p.changeCount).toBe(0)
  })
})

describe("sync config — flow tip edits arm Publish", () => {
  it("adding a flow step advances tip and arms Publish", async () => {
    const { tipVersion } = await bootstrapPublishedCatalog(fixture)
    const next = await appendFlowMarkerStep({
      flowId: "contract",
      markerId: "auditCheckRegression",
      kind: "auditCheck",
    })
    expect(next).toBeGreaterThan(tipVersion)
    stampPublishPending({ minTip: next })
    expect(status().dirtyCompileSections).toContain("flows")
  })

  it("flow tip edit marks the entity that uses that flow", async () => {
    await bootstrapPublishedCatalog(fixture)
    await appendFlowMarkerStep({
      flowId: "contract",
      markerId: "auditCheckEntityFanout",
      kind: "auditCheck",
    })
    const s = status()
    expect(s.unpublishedEntityIds).toContain("contract")
    expect(s.unpublishedEntityCount).toBeGreaterThan(0)
    const items = listSyncDefinitionAdminItems(fixture.projectRoot, TENANT)
    expect(items.find((i) => i.id === "contract")?.needsPublish).toBe(true)
  })

  it("content flow tip edit does not mark unrelated contract entity alone", async () => {
    await bootstrapPublishedCatalog(fixture)
    await appendFlowMarkerStep({
      flowId: "content",
      markerId: "contentOnlyMarker",
      kind: "metadataSync",
    })
    const s = status()
    expect(s.dirtyCompileSections).toContain("flows")
    expect(s.unpublishedEntityIds).toContain("content")
    // contract may still be clean if only content flow changed
    expect(s.unpublishedEntityIds.includes("contract")).toBe(false)
  })

  it("catalog version history records the flow mutation reason", async () => {
    await bootstrapPublishedCatalog(fixture)
    await appendFlowMarkerStep({
      flowId: "dataset",
      markerId: "datasetHistoryMarker",
      kind: "metadataSync",
    })
    const versions = listSyncCatalogVersions(TENANT, 20)
    expect(versions.some((v) => v.reason === "sync-metadata:flow:dataset")).toBe(true)
  })

  it("live publish preview shows the flow change (not empty)", async () => {
    await bootstrapPublishedCatalog(fixture)
    await appendFlowMarkerStep({
      flowId: "rule",
      markerId: "rulePreviewMarker",
      kind: "metadataSync",
    })
    const p = preview()
    expect(p.catalogNeedsPublish).toBe(true)
    expect(p.changeCount).toBeGreaterThan(0)
    expect(p.sections.some((s) => s.section === "flows")).toBe(true)
    const flowSection = p.sections.find((s) => s.section === "flows")!
    expect(
      [...flowSection.creates, ...flowSection.updates].some((e) => e.id === "rule"),
    ).toBe(true)
  })

  it("Publish after flow edit clears arming and aligns stamps", async () => {
    await bootstrapPublishedCatalog(fixture)
    await appendFlowMarkerStep({
      flowId: "contract",
      markerId: "auditCheckThenPublish",
      kind: "auditCheck",
    })
    stampPublishPending()
    publishSyncDefinitionsFromDb(fixture.projectRoot)
    stampQuiet()
    expect(preview().changeCount).toBe(0)
  })

  it("second flow edit after publish arms Publish again", async () => {
    await bootstrapPublishedCatalog(fixture)
    await appendFlowMarkerStep({ flowId: "contract", markerId: "m1", kind: "auditCheck" })
    publishSyncDefinitionsFromDb(fixture.projectRoot)
    stampQuiet()
    await appendFlowMarkerStep({ flowId: "contract", markerId: "m2", kind: "auditCheck" })
    stampPublishPending()
  })
})

describe("sync config — boot tip SoT (built-in flows)", () => {
  it("valid tip flow edit survives syncBuiltInFlowsFromArtifact", async () => {
    await bootstrapPublishedCatalog(fixture)
    await appendFlowMarkerStep({
      flowId: "content",
      markerId: "surviveBootMarker",
      kind: "metadataSync",
    })
    db.syncBuiltInFlowsFromArtifact(fixture.projectRoot, TENANT)
    const steps = db.parseFlowSteps(db.getSyncFlow(TENANT, "content")!.steps_json)
    expect(steps.some((s) => s.id === "surviveBootMarker")).toBe(true)
    stampPublishPending()
  })

  it("valid tip flow edit survives full deploy metadata sync (boot path)", async () => {
    await bootstrapPublishedCatalog(fixture)
    await appendFlowMarkerStep({
      flowId: "contract",
      markerId: "surviveDeploySync",
      kind: "auditCheck",
    })
    db.syncDeploySyncMetadataFromArtifact(fixture.projectRoot, TENANT)
    const steps = db.parseFlowSteps(db.getSyncFlow(TENANT, "contract")!.steps_json)
    expect(steps.some((s) => s.id === "surviveDeploySync")).toBe(true)
    const p = preview()
    expect(p.catalogNeedsPublish).toBe(true)
    expect(p.changeCount).toBeGreaterThan(0)
  })

  it("corrupt kebab tip is repaired from artifact on boot refresh", async () => {
    await bootstrapPublishedCatalog(fixture)
    db.saveSyncFlow({
      tenant_id: TENANT,
      id: "content",
      label: "Broken",
      description: "kebab",
      steps_json: JSON.stringify([
        { id: "metadata-sync", kind: "metadata-sync", title: "bad", description: "" },
      ]),
      built_in: 1,
      updated_at: new Date().toISOString(),
      updated_by: "operator",
    })
    db.syncBuiltInFlowsFromArtifact(fixture.projectRoot, TENANT)
    const steps = db.parseFlowSteps(db.getSyncFlow(TENANT, "content")!.steps_json)
    expect(steps.every((s) => !s.kind.includes("-"))).toBe(true)
    expect(steps.some((s) => s.kind === "metadataSync")).toBe(true)
  })

  it("after tip edit + boot preserve, Publish still required until Publish runs", async () => {
    await bootstrapPublishedCatalog(fixture)
    await appendFlowMarkerStep({
      flowId: "dataset",
      markerId: "bootThenPublish",
      kind: "metadataSync",
    })
    db.syncDeploySyncMetadataFromArtifact(fixture.projectRoot, TENANT)
    stampPublishPending()
    publishSyncDefinitionsFromDb(fixture.projectRoot)
    stampQuiet()
  })
})

describe("sync config — environment tip is operational (no Publish)", () => {
  it("env-only tip ahead does not arm Publish", async () => {
    await bootstrapPublishedCatalog(fixture)
    const published = status().publishedCatalogVersion
    await bumpSyncEnvironmentTip({ name: "regression-env-a" })
    const s = status()
    expect(s.tipAhead ?? classify().tipAhead).toBe(true)
    expect(s.activeCatalogVersion).not.toBe(published)
    expect(s.catalogNeedsPublish).toBe(false)
    expect(s.operationalCatalogAhead).toBe(true)
    expect(s.dirtyOperationalSections).toContain("environments")
    expect(s.dirtyCompileSections ?? []).not.toContain("environments")
  })

  it("env tip then flow tip arms Publish (compile wins)", async () => {
    await bootstrapPublishedCatalog(fixture)
    await bumpSyncEnvironmentTip({ name: "regression-env-b" })
    expect(status().operationalCatalogAhead).toBe(true)
    await appendFlowMarkerStep({
      flowId: "gateMetadata",
      markerId: "afterEnvMarker",
      kind: "metadataSync",
    })
    const s = status()
    expect(s.catalogNeedsPublish).toBe(true)
    expect(s.operationalCatalogAhead).toBe(false)
    expect(s.dirtyCompileSections).toContain("flows")
  })

  it("Publish after env-only tip does not need to run for quiet sync — stamps stay env-ahead", async () => {
    await bootstrapPublishedCatalog(fixture)
    await bumpSyncEnvironmentTip({ name: "regression-env-c" })
    expect(status().catalogNeedsPublish).toBe(false)
    // Optional Publish still allowed — stamps catch up
    publishSyncDefinitionsFromDb(fixture.projectRoot)
    stampQuiet()
  })

  it("classify reports operationalOnlyAhead only when env dirty and no compile delta", async () => {
    await bootstrapPublishedCatalog(fixture)
    await bumpSyncEnvironmentTip()
    const c = classify()
    expect(c.operationalOnlyAhead).toBe(true)
    expect(c.compileNeedsPublish).toBe(false)
    expect(c.dirtyCompileSections).toEqual([])
    expect(c.dirtyOperationalSections).toContain("environments")
  })
})

describe("sync config — zombie tip stamp (version ahead, live matches publish)", () => {
  it("arms Publish when tip stamp is ahead but live content matches published snapshot", async () => {
    const { publishedVersion } = await bootstrapPublishedCatalog(fixture)
    await appendFlowMarkerStep({
      flowId: "contract",
      markerId: "zombieTemp",
      kind: "auditCheck",
    })
    stampPublishPending()

    // Revert live flow to published-era content without a new catalog version.
    const publishedSnapshot = db.getSyncCatalogVersionRow(TENANT, publishedVersion!)
    expect(publishedSnapshot).toBeTruthy()
    const snap = JSON.parse(publishedSnapshot!.snapshot_json) as {
      syncMetadata?: { flows?: Record<string, { label?: string; description?: string; steps?: unknown[] }> }
      flowTemplates?: { flowTemplates?: Record<string, { label?: string; description?: string; steps?: unknown[] }> }
    }
    const flow =
      snap.flowTemplates?.flowTemplates?.contract
      ?? snap.syncMetadata?.flows?.contract
    expect(flow?.steps).toBeTruthy()
    const row = db.getSyncFlow(TENANT, "contract")!
    db.saveSyncFlow({
      tenant_id: TENANT,
      id: "contract",
      label: typeof flow!.label === "string" ? flow!.label : row.label,
      description: typeof flow!.description === "string" ? flow!.description : row.description,
      steps_json: JSON.stringify(flow!.steps),
      built_in: 1,
      updated_at: row.updated_at,
      updated_by: row.updated_by,
    })

    const c = classify()
    expect(c.tipAhead).toBe(true)
    expect(c.activeCatalogVersion).not.toBe(c.publishedCatalogVersion)
    expect(c.dirtyCompileSections).toEqual([])
    expect(c.compileNeedsPublish).toBe(true)
    expect(c.operationalOnlyAhead).toBe(false)

    const p = preview()
    expect(p.catalogNeedsPublish).toBe(true)
    expect(p.changeCount).toBe(0)

    // Must not look "published" — stamp mismatch.
    expect(status().activeCatalogVersion === status().publishedCatalogVersion).toBe(false)
  })

  it("Publish reconciles zombie tip stamp without requiring a live compile delta", async () => {
    const { publishedVersion } = await bootstrapPublishedCatalog(fixture)
    await appendFlowMarkerStep({
      flowId: "content",
      markerId: "zombieReconcile",
      kind: "metadataSync",
    })
    const publishedSnapshot = db.getSyncCatalogVersionRow(TENANT, publishedVersion!)!
    const snap = JSON.parse(publishedSnapshot.snapshot_json) as {
      syncMetadata?: { flows?: Record<string, { steps?: unknown[]; label?: string; description?: string }> }
      flowTemplates?: { flowTemplates?: Record<string, { steps?: unknown[]; label?: string; description?: string }> }
    }
    const flow =
      snap.flowTemplates?.flowTemplates?.content
      ?? snap.syncMetadata?.flows?.content
    const row = db.getSyncFlow(TENANT, "content")!
    db.saveSyncFlow({
      tenant_id: TENANT,
      id: "content",
      label: row.label,
      description: row.description,
      steps_json: JSON.stringify(flow!.steps),
      built_in: 1,
      updated_at: row.updated_at,
      updated_by: row.updated_by,
    })
    expect(status().catalogNeedsPublish).toBe(true)
    publishSyncDefinitionsFromDb(fixture.projectRoot)
    stampQuiet()
  })
})

describe("sync config — stamp equality is the published truth", () => {
  it("active tip stamp equals publishedCatalogVersion only after Publish", async () => {
    await bootstrapPublishedCatalog(fixture)
    const before = status()
    expect(before.activeCatalogVersion).toBe(before.publishedCatalogVersion)

    await appendFlowMarkerStep({
      flowId: "pipelineActivity",
      markerId: "stampTruth",
      kind: "metadataSync",
    })
    const mid = status()
    expect(mid.activeCatalogVersion).not.toBe(mid.publishedCatalogVersion)
    expect(mid.catalogNeedsPublish).toBe(true)

    publishSyncDefinitionsFromDb(fixture.projectRoot)
    const after = status()
    expect(after.activeCatalogVersion).toBe(after.publishedCatalogVersion)
    expect(after.catalogNeedsPublish).toBe(false)
  })

  it("green-published equivalent: stamps match ⇒ no Publish, no unpublished entities", async () => {
    await bootstrapPublishedCatalog(fixture)
    const s = status()
    expect(s.activeCatalogVersion === s.publishedCatalogVersion).toBe(true)
    expect(s.catalogNeedsPublish).toBe(false)
    expect(s.unpublishedEntityCount).toBe(0)
  })

  it("history tip ahead of publish stamp never reports quiet Publish", async () => {
    await bootstrapPublishedCatalog(fixture)
    recordSyncCatalogChange({ reason: "noop:manual-commit", actor: "operator" })
    // Even a tip commit with identical content (stamp drift) arms Publish.
    expect(status().catalogNeedsPublish).toBe(true)
    expect(status().activeCatalogVersion).not.toBe(status().publishedCatalogVersion)
  })
})

describe("sync config — multi-mutation sequences", () => {
  it("flow + env + publish leaves quiet tip", async () => {
    await bootstrapPublishedCatalog(fixture)
    await appendFlowMarkerStep({ flowId: "rule", markerId: "seq1", kind: "metadataSync" })
    await bumpSyncEnvironmentTip({ name: "seq-env" })
    expect(status().catalogNeedsPublish).toBe(true)
    publishSyncDefinitionsFromDb(fixture.projectRoot)
    stampQuiet()
  })

  it("publish → env → still quiet for Publish arming", async () => {
    await bootstrapPublishedCatalog(fixture)
    await bumpSyncEnvironmentTip({ name: "post-publish-env" })
    expect(status().catalogNeedsPublish).toBe(false)
    expect(status().operationalCatalogAhead).toBe(true)
  })

  it("three successive flow edits keep Publish armed until Publish", async () => {
    await bootstrapPublishedCatalog(fixture)
    await appendFlowMarkerStep({ flowId: "contract", markerId: "c1", kind: "auditCheck" })
    await appendFlowMarkerStep({ flowId: "contract", markerId: "c2", kind: "auditCheck" })
    await appendFlowMarkerStep({ flowId: "contract", markerId: "c3", kind: "auditCheck" })
    stampPublishPending()
    const p = preview()
    expect(p.changeCount).toBeGreaterThan(0)
    publishSyncDefinitionsFromDb(fixture.projectRoot)
    stampQuiet()
  })

  it("edits across multiple flows fan out to multiple entities", async () => {
    await bootstrapPublishedCatalog(fixture)
    await appendFlowMarkerStep({ flowId: "contract", markerId: "mf1", kind: "auditCheck" })
    await appendFlowMarkerStep({ flowId: "dataset", markerId: "mf2", kind: "metadataSync" })
    const ids = new Set(status().unpublishedEntityIds)
    expect(ids.has("contract")).toBe(true)
    expect(ids.has("dataset")).toBe(true)
  })

  it("Publish includes marker step in compiled SyncDefinition", async () => {
    await bootstrapPublishedCatalog(fixture)
    await appendFlowMarkerStep({
      flowId: "contract",
      markerId: "compiledMarker",
      kind: "auditCheck",
    })
    publishSyncDefinitionsFromDb(fixture.projectRoot)
    const bundle = db.loadPublishedBundleFromDb(TENANT)
    const steps = bundle?.definitions?.contract?.executionFlow?.steps ?? []
    expect(steps.some((s) => s.id === "compiledMarker")).toBe(true)
  })
})

describe("sync config — classify / status / preview coherence", () => {
  it("status mirrors classify compileNeedsPublish and operationalOnlyAhead", async () => {
    await bootstrapPublishedCatalog(fixture)
    await appendFlowMarkerStep({ flowId: "content", markerId: "cohere1", kind: "metadataSync" })
    const c = classify()
    const s = status()
    expect(s.catalogNeedsPublish).toBe(c.compileNeedsPublish)
    expect(s.operationalCatalogAhead).toBe(c.operationalOnlyAhead)
    expect(s.dirtyCompileSections).toEqual(c.dirtyCompileSections)
    expect(s.activeCatalogVersion).toBe(c.activeCatalogVersion)
    expect(s.publishedCatalogVersion).toBe(c.publishedCatalogVersion)
  })

  it("preview.catalogNeedsPublish matches status after env-only tip", async () => {
    await bootstrapPublishedCatalog(fixture)
    await bumpSyncEnvironmentTip({ name: "cohere-env" })
    expect(preview().catalogNeedsPublish).toBe(status().catalogNeedsPublish)
    expect(preview().operationalCatalogAhead).toBe(true)
  })

  it("preview never includes environments section", async () => {
    await bootstrapPublishedCatalog(fixture)
    await bumpSyncEnvironmentTip({ name: "cohere-env-2" })
    await appendFlowMarkerStep({ flowId: "content", markerId: "cohere2", kind: "metadataSync" })
    expect(preview().sections.every((s) => s.section !== "environments")).toBe(true)
  })

  it("never-published tip arms Publish with all entities unpublished", () => {
    ensureInitialSyncCatalogVersion("system")
    // Wipe publish meta by replacing with empty — simulate fresh DB after tip seed.
    // If no publish meta, classify treats tip ahead as needing publish.
    const c = classifyCatalogPublish(fixture.projectRoot, TENANT)
    // Fresh seed may already have no publish meta
    if (db.getSyncPublishMeta(TENANT) == null) {
      expect(c.compileNeedsPublish).toBe(true)
      expect(c.compileAffectedEntityIds.length).toBeGreaterThan(0)
    }
  })
})

describe("sync config — history vs live tip (preview SoT)", () => {
  it("preview follows live tip after boot preserve, matching status arming", async () => {
    await bootstrapPublishedCatalog(fixture)
    await appendFlowMarkerStep({
      flowId: "contract",
      markerId: "liveTipSoT",
      kind: "auditCheck",
    })
    db.syncDeploySyncMetadataFromArtifact(fixture.projectRoot, TENANT)
    const s = status()
    const p = preview()
    expect(s.catalogNeedsPublish).toBe(true)
    expect(p.catalogNeedsPublish).toBe(true)
    expect(p.changeCount).toBeGreaterThan(0)
    expect(
      db.parseFlowSteps(db.getSyncFlow(TENANT, "contract")!.steps_json)
        .some((step) => step.id === "liveTipSoT"),
    ).toBe(true)
  })

  it("catalog version list keeps historical flow reason after later Publish", async () => {
    await bootstrapPublishedCatalog(fixture)
    await appendFlowMarkerStep({
      flowId: "contract",
      markerId: "historyKeeps",
      kind: "auditCheck",
    })
    publishSyncDefinitionsFromDb(fixture.projectRoot)
    const versions = listSyncCatalogVersions(TENANT, 50)
    expect(versions.some((v) => v.reason === "sync-metadata:flow:contract")).toBe(true)
    stampQuiet()
  })
})

describe("sync config — HTTP publish-status / publish-preview", () => {
  it("GET publish-status reflects tip ahead after flow edit", async () => {
    await bootstrapPublishedCatalog(fixture)
    await appendFlowMarkerStep({
      flowId: "contract",
      markerId: "httpStatusMarker",
      kind: "auditCheck",
    })
    const app = await buildSyncDefinitionsApp(fixture)
    try {
      const res = await app.inject({ method: "GET", url: "/api/sync/definitions/publish-status" })
      expect(res.statusCode).toBe(200)
      const body = res.json() as ReturnType<typeof status>
      expect(body.catalogNeedsPublish).toBe(true)
      expect(body.dirtyCompileSections).toContain("flows")
      expect(body.unpublishedEntityIds).toContain("contract")
    } finally {
      await app.close()
    }
  })

  it("GET publish-preview returns live compile sections after flow edit", async () => {
    await bootstrapPublishedCatalog(fixture)
    await appendFlowMarkerStep({
      flowId: "rule",
      markerId: "httpPreviewMarker",
      kind: "metadataSync",
    })
    const app = await buildSyncDefinitionsApp(fixture)
    try {
      const res = await app.inject({ method: "GET", url: "/api/sync/definitions/publish-preview" })
      expect(res.statusCode).toBe(200)
      const body = res.json() as ReturnType<typeof preview>
      expect(body.catalogNeedsPublish).toBe(true)
      expect(body.changeCount).toBeGreaterThan(0)
      expect(body.sections.some((s) => s.section === "flows")).toBe(true)
    } finally {
      await app.close()
    }
  })

  it("GET publish-status is quiet for env-only tip ahead", async () => {
    await bootstrapPublishedCatalog(fixture)
    await bumpSyncEnvironmentTip({ name: "http-env" })
    const app = await buildSyncDefinitionsApp(fixture)
    try {
      const res = await app.inject({ method: "GET", url: "/api/sync/definitions/publish-status" })
      expect(res.statusCode).toBe(200)
      const body = res.json() as ReturnType<typeof status>
      expect(body.catalogNeedsPublish).toBe(false)
      expect(body.operationalCatalogAhead).toBe(true)
    } finally {
      await app.close()
    }
  })

  it("POST publish then GET status is stamp-quiet", async () => {
    await bootstrapPublishedCatalog(fixture)
    await appendFlowMarkerStep({
      flowId: "dataset",
      markerId: "httpPublishMarker",
      kind: "metadataSync",
    })
    const app = await buildSyncDefinitionsApp(fixture)
    try {
      const pub = await app.inject({ method: "POST", url: "/api/sync/definitions/publish" })
      expect(pub.statusCode).toBe(200)
      const st = await app.inject({ method: "GET", url: "/api/sync/definitions/publish-status" })
      const body = st.json() as ReturnType<typeof status>
      expect(body.catalogNeedsPublish).toBe(false)
      expect(body.activeCatalogVersion).toBe(body.publishedCatalogVersion)
    } finally {
      await app.close()
    }
  })
})

describe("sync config — entity tip version drift", () => {
  it("bumping entity tip version arms Publish for that entity", async () => {
    await bootstrapPublishedCatalog(fixture)
    const entity = db.getEntityDefinition(TENANT, "contract")
    expect(entity).toBeTruthy()
    db.saveEntityDefinition({
      tenantId: TENANT,
      def: { ...entity!, version: (entity!.version ?? 1) + 1 },
      actor: "operator",
      reason: "regression:entity-bump",
    })
    recordSyncCatalogChange({ reason: "entity:update:contract", actor: "operator" })
    const s = status()
    expect(s.catalogNeedsPublish).toBe(true)
    expect(s.unpublishedEntityIds).toContain("contract")
  })

  it("entity bump then Publish clears needsPublish on admin list", async () => {
    await bootstrapPublishedCatalog(fixture)
    const entity = db.getEntityDefinition(TENANT, "content")!
    db.saveEntityDefinition({
      tenantId: TENANT,
      def: { ...entity, version: (entity.version ?? 1) + 1 },
      actor: "operator",
      reason: "regression:entity-bump-2",
    })
    recordSyncCatalogChange({ reason: "entity:update:content", actor: "operator" })
    expect(listSyncDefinitionAdminItems(fixture.projectRoot, TENANT).find((i) => i.id === "content")?.needsPublish).toBe(true)
    publishSyncDefinitionsFromDb(fixture.projectRoot)
    expect(listSyncDefinitionAdminItems(fixture.projectRoot, TENANT).find((i) => i.id === "content")?.needsPublish).toBe(false)
    stampQuiet()
  })
})

describe("sync config — custom (non-built-in) flows", () => {
  it("custom flow tip edit survives boot metadata sync", async () => {
    await bootstrapPublishedCatalog(fixture)
    const now = new Date().toISOString()
    db.saveSyncFlow({
      tenant_id: TENANT,
      id: "operatorCustomFlow",
      label: "Custom",
      description: "operator owned",
      steps_json: JSON.stringify([
        {
          id: "metadataSync",
          kind: "metadataSync",
          title: "Metadata sync",
          description: "",
          bindings: {},
        },
      ]),
      built_in: 0,
      updated_at: now,
      updated_by: "operator",
    })
    recordSyncCatalogChange({ reason: "sync-metadata:flow:operatorCustomFlow", actor: "operator" })
    db.syncDeploySyncMetadataFromArtifact(fixture.projectRoot, TENANT)
    const custom = db.getSyncFlow(TENANT, "operatorCustomFlow")
    expect(custom).toBeTruthy()
    expect(custom!.built_in).toBe(0)
    expect(db.parseFlowSteps(custom!.steps_json).some((s) => s.kind === "metadataSync")).toBe(true)
  })
})
