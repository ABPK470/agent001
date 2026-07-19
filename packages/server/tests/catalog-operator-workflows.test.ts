/**
 * Operator workflow integration tests — catalog id rules, import/export, versioning, publish.
 *
 * Scenarios mirror what an operator does in Configuration → Import/Export → Versions → Publish.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  applyDeployCatalogSnapshot,
  validateDeployCatalogSnapshot,
} from "../src/api/platform/service/import-deploy-artifacts.js"
import { buildDeployCatalogSnapshot } from "../src/api/platform/service/export-deploy-artifacts.js"
import {
  commitSyncCatalogVersion,
  rollbackSyncCatalogVersion,
} from "../src/api/platform/service/sync-catalog-versioning.js"
import {
  listSyncDefinitionAdminItems,
  loadAuthoringFlowCatalog,
  publishSyncDefinitionsFromDb,
} from "../src/api/sync/service/definitions.js"
import {
  buildFlowCatalogFromSyncMetadataDoc,
  FlowStepsValidationError,
  prepareFlowStepsForStorage,
} from "../src/infra/persistence/sync-flow-steps.js"
import * as db from "../src/infra/persistence/db/index.js"
import { isCatalogId } from "@mia/shared-types"
import {
  buildSyncMetadataApp,
  contentFlowStepsFromDb,
  listPresetStepKinds,
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

describe("catalog operator workflows — first-principles invariants", () => {
  it("seeded flow presets use camelCase step ids and kinds only", () => {
    for (const preset of db.listSyncFlows(TENANT)) {
      const steps = db.parseFlowSteps(preset.steps_json)
      expect(steps.length).toBeGreaterThan(0)
      for (const step of steps) {
        expect(isCatalogId(step.id), `preset ${preset.id} step id ${step.id}`).toBe(true)
        expect(isCatalogId(step.kind), `preset ${preset.id} step kind ${step.kind}`).toBe(true)
      }
    }
    expect(listPresetStepKinds()).toContain("metadataSync")
    expect(listPresetStepKinds().some((kind) => kind.includes("-"))).toBe(false)
  })

  it("exported catalog snapshot validates without errors", () => {
    const snapshot = buildDeployCatalogSnapshot({ tenantId: TENANT })
    const preview = validateDeployCatalogSnapshot(snapshot)
    expect(preview.ok).toBe(true)
    expect(preview.errors).toEqual([])
  })

  it("prepareFlowStepsForStorage strips phase before persistence", () => {
    const snapshot = buildDeployCatalogSnapshot({ tenantId: TENANT })
    const catalog = buildFlowCatalogFromSyncMetadataDoc(
      snapshot.syncMetadata as Parameters<typeof buildFlowCatalogFromSyncMetadataDoc>[0],
    )
    const steps = contentFlowStepsFromDb().map((step) => ({
      ...step,
      phase: "metadata" as const,
    }))
    const stored = prepareFlowStepsForStorage(steps, catalog)
    expect(stored.every((step) => !("phase" in step))).toBe(true)
    expect(stored.some((step) => step.kind === "metadataSync")).toBe(true)
  })

  it("rejects kebab-case kinds at the shared validation ingress", () => {
    const snapshot = buildDeployCatalogSnapshot({ tenantId: TENANT })
    const catalog = buildFlowCatalogFromSyncMetadataDoc(
      snapshot.syncMetadata as Parameters<typeof buildFlowCatalogFromSyncMetadataDoc>[0],
    )
    expect(() =>
      prepareFlowStepsForStorage(
        [
          {
            id: "metadata-sync",
            phase: "metadata",
            kind: "metadata-sync",
            title: "Metadata sync",
            description: "bad",
          },
        ],
        catalog,
      ),
    ).toThrow(FlowStepsValidationError)
  })

  it("rejects flow steps that reference unknown kinds", () => {
    const snapshot = buildDeployCatalogSnapshot({ tenantId: TENANT })
    const catalog = buildFlowCatalogFromSyncMetadataDoc(
      snapshot.syncMetadata as Parameters<typeof buildFlowCatalogFromSyncMetadataDoc>[0],
    )
    const error = (() => {
      try {
        prepareFlowStepsForStorage(
          [
            {
              id: "metadataSync",
              kind: "metadataSync",
              title: "Metadata sync",
              description: "ok",
            },
            {
              id: "doesNotExist",
              kind: "doesNotExist",
              title: "Missing kind",
              description: "bad",
            },
          ],
          catalog,
        )
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })()
    expect(error).toBeTruthy()
  })
})

describe("catalog operator workflows — Configuration API", () => {
  it("POST /api/sync-metadata/flows rejects kebab-case step kinds", async () => {
    const app = await buildSyncMetadataApp(fixture)
    const response = await app.inject({
      method: "POST",
      url: "/api/sync-metadata/flows",
      payload: {
        id: "content",
        label: "Content",
        steps: [
          {
            id: "metadata-sync",
            phase: "metadata",
            kind: "metadata-sync",
            title: "Metadata sync",
            description: "bad",
          },
        ],
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: expect.stringMatching(/camelCase/) })
    await app.close()
  })

  it("POST /api/sync-metadata/flows accepts canonical steps and strips phase in SQLite", async () => {
    const app = await buildSyncMetadataApp(fixture)
    const steps = contentFlowStepsFromDb().map((step) => ({
      ...step,
      phase: step.kind === "metadataSync" ? "metadata" : "postMetadata",
    }))

    const response = await app.inject({
      method: "POST",
      url: "/api/sync-metadata/flows",
      payload: {
        id: "content",
        label: "Content dependencies",
        description: "operator edit",
        steps,
      },
    })
    expect(response.statusCode).toBe(200)

    const stored = db.getSyncFlow(TENANT, "content")
    expect(stored).toBeTruthy()
    const parsed = JSON.parse(stored!.steps_json) as Array<Record<string, unknown>>
    expect(parsed.every((step) => !("phase" in step))).toBe(true)
    expect(parsed.some((step) => step.kind === "metadataSync")).toBe(true)
    await app.close()
  })

  it("GET /api/sync-metadata returns camelCase flow steps after operator save", async () => {
    const app = await buildSyncMetadataApp(fixture)
    const steps = contentFlowStepsFromDb()

    await app.inject({
      method: "POST",
      url: "/api/sync-metadata/flows",
      payload: { id: "content", label: "Content", steps },
    })

    const response = await app.inject({ method: "GET", url: "/api/sync-metadata" })
    expect(response.statusCode).toBe(200)
    const flows = response.json().flows as Array<{ id: string; steps: Array<{ kind: string }> }>
    const content = flows.find((flow) => flow.id === "content")
    expect(content?.steps.some((step) => step.kind === "metadataSync")).toBe(true)
    await app.close()
  })
})

describe("catalog operator workflows — import and export", () => {
  it("dry-run import previews without mutating SQLite", () => {
    const snapshot = buildDeployCatalogSnapshot({ tenantId: TENANT })
    const beforeFlowId = db.getEntityDefinition(TENANT, "dataset")?.flowId

    const preview = applyDeployCatalogSnapshot({
      snapshot,
      actor: "operator",
      projectRoot: fixture.projectRoot,
      dryRun: true,
    })
    expect(preview.ok).toBe(true)
    expect(preview.applied).toBe(false)
    expect(db.getEntityDefinition(TENANT, "dataset")?.flowId).toBe(beforeFlowId)
  })

  it("rejects kebab-case flows in import preview before any writes", () => {
    const snapshot = buildDeployCatalogSnapshot({ tenantId: TENANT })
    const meta = snapshot.syncMetadata as {
      flows?: Record<string, { label: string; description?: string; steps: unknown[] }>
    }
    meta.flows!.content!.steps = [
      {
        id: "metadata-sync",
        phase: "metadata",
        kind: "metadata-sync",
        title: "Metadata sync",
        description: "bad",
      },
    ]

    const preview = validateDeployCatalogSnapshot(snapshot)
    expect(preview.ok).toBe(false)
    expect(applyDeployCatalogSnapshot({
      snapshot,
      actor: "operator",
      projectRoot: fixture.projectRoot,
      dryRun: false,
    }).applied).toBe(false)
  })

  it("export → clear flowId → import restores entity flowId", () => {
    const snapshot = buildDeployCatalogSnapshot({ tenantId: TENANT })
    const datasetBefore = snapshot.entityRegistry?.entities.find(
      (entry) => (entry as { id?: string }).id === "dataset",
    ) as { flowId?: string } | undefined
    expect(datasetBefore?.flowId).toBeTruthy()

    const entity = db.getEntityDefinition(TENANT, "dataset")
    expect(entity).toBeTruthy()
    db.saveEntityDefinition({
      tenantId: TENANT,
      actor: "operator",
      reason: "clear-flow",
      def: { ...entity!, flowId: "metadataOnly" },
    })

    const applied = applyDeployCatalogSnapshot({
      snapshot,
      actor: "operator",
      projectRoot: fixture.projectRoot,
      dryRun: false,
    })
    expect(applied.applied).toBe(true)

    expect(db.getEntityDefinition(TENANT, "dataset")?.flowId).toBe(datasetBefore?.flowId)
    const adminItems = listSyncDefinitionAdminItems(fixture.projectRoot)
    expect(adminItems.find((item) => item.id === "dataset")?.executionSteps.length).toBeGreaterThan(0)
  })

  it("import retires entities the operator added after the exported baseline", () => {
    const snapshot = buildDeployCatalogSnapshot({ tenantId: TENANT })
    const template = db.getEntityDefinition(TENANT, "contract")
    expect(template).toBeTruthy()

    db.saveEntityDefinition({
      tenantId: TENANT,
      actor: "operator",
      reason: "operator-add",
      def: { ...template!, id: "operatorOrphan", displayName: "Operator Orphan" },
    })
    expect(db.getEntityDefinition(TENANT, "operatorOrphan")).toBeTruthy()

    applyDeployCatalogSnapshot({
      snapshot,
      actor: "operator",
      projectRoot: fixture.projectRoot,
      dryRun: false,
    })

    expect(db.getEntityDefinition(TENANT, "operatorOrphan")).toBeNull()
    expect(db.getEntityDefinition(TENANT, "operatorOrphan", { includeRetired: true })?.retiredAt).toBeTruthy()
  })

  it("rejects snapshots with kebab-case action ids", () => {
    const snapshot = buildDeployCatalogSnapshot({ tenantId: TENANT })
    const meta = snapshot.syncMetadata as {
      actions?: Array<{ id: string; label: string; definition: unknown }>
    }
    meta.actions = [
      ...(meta.actions ?? []).filter((row) => row.id !== "metadataSync"),
      { id: "metadata-sync", label: "bad", definition: {} },
    ]

    const preview = validateDeployCatalogSnapshot(snapshot)
    expect(preview.ok).toBe(false)
    expect(preview.errors.some((error) => error.includes("camelCase"))).toBe(true)
  })
})

describe("catalog operator workflows — configuration versions and rollback", () => {
  it("commit captures operator state; rollback restores entity registry", () => {
    const baseline = commitSyncCatalogVersion({ reason: "operator-baseline", actor: "operator" })
    const template = db.getEntityDefinition(TENANT, "contract")
    expect(template).toBeTruthy()

    db.saveEntityDefinition({
      tenantId: TENANT,
      actor: "operator",
      reason: "operator-add",
      def: { ...template!, id: "versionOrphan", displayName: "Version Orphan" },
    })
    commitSyncCatalogVersion({ reason: "operator-follow-up", actor: "operator" })
    expect(db.getEntityDefinition(TENANT, "versionOrphan")).toBeTruthy()

    rollbackSyncCatalogVersion({
      targetVersion: baseline.version,
      actor: "operator",
      projectRoot: fixture.projectRoot,
    })

    expect(db.getEntityDefinition(TENANT, "versionOrphan")).toBeNull()
    expect(db.getEntityDefinition(TENANT, "contract")).toBeTruthy()
  })

  it("rollback restores flow preset steps from the committed snapshot", () => {
    const baseline = commitSyncCatalogVersion({ reason: "flow-baseline", actor: "operator" })

    db.saveSyncFlow({
      tenant_id: TENANT,
      id: "content",
      label: "Broken content",
      description: "operator broke flow",
      steps_json: "[]",
      built_in: 1,
      updated_at: new Date().toISOString(),
      updated_by: "operator",
    })
    commitSyncCatalogVersion({ reason: "flow-broken", actor: "operator" })
    expect(db.parseFlowSteps(db.getSyncFlow(TENANT, "content")!.steps_json)).toEqual([])

    rollbackSyncCatalogVersion({
      targetVersion: baseline.version,
      actor: "operator",
      projectRoot: fixture.projectRoot,
    })

    const restored = db.parseFlowSteps(db.getSyncFlow(TENANT, "content")!.steps_json)
    expect(restored.some((step) => step.kind === "metadataSync")).toBe(true)
  })

  it("publish succeeds for core entities after rollback to known-good version", () => {
    const baseline = commitSyncCatalogVersion({ reason: "publish-baseline", actor: "operator" })

    db.saveSyncFlow({
      tenant_id: TENANT,
      id: "content",
      label: "Broken content",
      description: "empty",
      steps_json: "[]",
      built_in: 1,
      updated_at: new Date().toISOString(),
      updated_by: "operator",
    })
    commitSyncCatalogVersion({ reason: "publish-broken", actor: "operator" })

    rollbackSyncCatalogVersion({
      targetVersion: baseline.version,
      actor: "operator",
      projectRoot: fixture.projectRoot,
    })

    const result = publishSyncDefinitionsFromDb(fixture.projectRoot)
    for (const entityId of ["content", "contract", "dataset"]) {
      expect(result.stderr.some((line) => line.includes(`Refusing to publish "${entityId}"`))).toBe(false)
    }
  })

  it("chained operator cycle: baseline → break → commit → rollback → import → publish", () => {
    const baseline = commitSyncCatalogVersion({ reason: "cycle-baseline", actor: "operator" })

    db.saveSyncFlow({
      tenant_id: TENANT,
      id: "dataset",
      label: "Broken dataset",
      description: "empty",
      steps_json: "[]",
      built_in: 1,
      updated_at: new Date().toISOString(),
      updated_by: "operator",
    })
    commitSyncCatalogVersion({ reason: "cycle-broken", actor: "operator" })

    rollbackSyncCatalogVersion({
      targetVersion: baseline.version,
      actor: "operator",
      projectRoot: fixture.projectRoot,
    })

    const reexport = buildDeployCatalogSnapshot({ tenantId: TENANT })
    expect(validateDeployCatalogSnapshot(reexport).ok).toBe(true)
    applyDeployCatalogSnapshot({
      snapshot: reexport,
      actor: "operator",
      projectRoot: fixture.projectRoot,
      dryRun: false,
    })

    const result = publishSyncDefinitionsFromDb(fixture.projectRoot)
    expect(result.definitionCount).toBeGreaterThan(0)
    expect(result.stderr.some((line) => line.includes('Refusing to publish "dataset"'))).toBe(false)
  })
})

describe("catalog operator workflows — publish pipeline", () => {
  it("falls back to shipped flow steps when operator left a built-in preset empty in SQLite", () => {
    db.saveSyncFlow({
      tenant_id: TENANT,
      id: "content",
      label: "Empty content",
      description: "operator cleared steps",
      steps_json: "[]",
      built_in: 1,
      updated_at: new Date().toISOString(),
      updated_by: "operator",
    })

    const catalog = loadAuthoringFlowCatalog(fixture.projectRoot, TENANT)
    expect(catalog.flowTemplates.content.steps.some((step) => step.kind === "metadataSync")).toBe(true)

    const result = publishSyncDefinitionsFromDb(fixture.projectRoot)
    expect(result.stderr.some((line) => line.includes('Refusing to publish "content"'))).toBe(false)
  })

  it("boot refresh repairs corrupt kebab-case built-in presets from deploy artifact", () => {
    db.saveSyncFlow({
      tenant_id: TENANT,
      id: "content",
      label: "Legacy content",
      description: "kebab injected",
      steps_json: JSON.stringify([
        {
          id: "metadata-sync",
          kind: "metadata-sync",
          title: "Metadata sync",
          description: "bad",
        },
      ]),
      built_in: 1,
      updated_at: new Date().toISOString(),
      updated_by: "operator",
    })

    db.syncBuiltInFlowsFromArtifact(fixture.projectRoot, TENANT)

    const steps = db.parseFlowSteps(db.getSyncFlow(TENANT, "content")!.steps_json)
    expect(steps.some((step) => step.kind === "metadataSync")).toBe(true)
    expect(steps.every((step) => isCatalogId(step.id) && isCatalogId(step.kind))).toBe(true)
  })

  it("boot refresh preserves valid tip edits on built-in flows (tip SoT)", () => {
    const before = db.parseFlowSteps(db.getSyncFlow(TENANT, "content")!.steps_json)
    const markerId = "regressionTipMarker"
    db.saveSyncFlow({
      tenant_id: TENANT,
      id: "content",
      label: db.getSyncFlow(TENANT, "content")!.label,
      description: "operator tip edit",
      steps_json: JSON.stringify([
        ...before,
        {
          id: markerId,
          kind: "metadataSync",
          title: "Tip marker",
          description: "must survive boot",
          bindings: {},
        },
      ]),
      built_in: 1,
      updated_at: new Date().toISOString(),
      updated_by: "operator",
    })

    db.syncBuiltInFlowsFromArtifact(fixture.projectRoot, TENANT)
    db.syncDeploySyncMetadataFromArtifact(fixture.projectRoot, TENANT)

    const after = db.parseFlowSteps(db.getSyncFlow(TENANT, "content")!.steps_json)
    // Tip SoT is steps_json; label/description may refresh from deploy artifact.
    expect(after.some((step) => step.id === markerId)).toBe(true)
    expect(after.length).toBeGreaterThan(before.length)
  })

  it("parseFlowSteps fails fast on operator custom presets with kebab-case ids", () => {
    db.saveSyncFlow({
      tenant_id: TENANT,
      id: "operatorCustomFlow",
      label: "Legacy corrupt",
      description: "kebab injected",
      steps_json: JSON.stringify([
        {
          id: "metadata-sync",
          kind: "metadata-sync",
          title: "Metadata sync",
          description: "bad",
        },
      ]),
      built_in: 0,
      updated_at: new Date().toISOString(),
      updated_by: "operator",
    })

    expect(() =>
      db.parseFlowSteps(db.getSyncFlow(TENANT, "operatorCustomFlow")!.steps_json),
    ).toThrow(FlowStepsValidationError)
  })

  it("import then publish resolves metadataSync for every core entity type", () => {
    const snapshot = buildDeployCatalogSnapshot({ tenantId: TENANT })
    applyDeployCatalogSnapshot({
      snapshot,
      actor: "operator",
      projectRoot: fixture.projectRoot,
      dryRun: false,
    })

    const result = publishSyncDefinitionsFromDb(fixture.projectRoot)
    expect(result.definitionCount).toBeGreaterThan(0)
    for (const entityId of ["content", "contract", "dataset"]) {
      expect(result.stderr.some((line) => line.includes(`Refusing to publish "${entityId}"`))).toBe(false)
    }
  })
})
