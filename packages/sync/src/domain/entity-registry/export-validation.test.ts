import { describe, expect, it } from "vitest"

import type { AuthoredSyncDefinition } from "@mia/shared-types"

import { entityDefinitionFromAuthoredSync } from "./from-authored-sync.js"
import {
  validateAuthoredExportRoundTrip,
  validateEntityExportable,
} from "./export-validation.js"
import type { EntityDefinition } from "./types.js"

function minimalEntity(overrides: Partial<EntityDefinition> = {}): EntityDefinition {
  return {
    id: "sample",
    tenantId: "_default",
    displayName: "Sample",
    description: "",
    rootTable: "core.Sample",
    idColumn: "sampleId",
    labelColumn: null,
    selfJoinColumn: null,
    tables: [
      {
        name: "core.Sample",
        executionOrder: 1,
        scope: { kind: "rootPk", column: "sampleId" },
        scd2Override: null,
        verified: true,
        archiveTable: null,
        note: null,
        provenance: { kind: "manual" },
        scopeColumn: "sampleId",
        source: "manual",
        groundedByPipeline: null,
        enabledByDefault: null,
        userControllable: null,
      },
    ],
    policies: { freezeWindowIds: [] },
    scd2: { strategyId: "mymi-scd2", strategyVersion: "latest", entityOverride: null },
    lineageRefs: [],
    provenance: { kind: "manual" },
    legacyEntrySproc: null,
    reverseOrder: [],
    discrepancies: [],
    version: 1,
    versionLabel: null,
    createdBy: "test",
    reason: "test",
    createdAt: new Date().toISOString(),
    retiredAt: null,
    ...overrides,
  }
}

describe("export validation", () => {
  it("accepts structurally valid entities for export", () => {
    expect(validateEntityExportable(minimalEntity()).ok).toBe(true)
  })

  it("rejects degraded predicates before export", () => {
    const entity = minimalEntity({
      tables: [
        {
          name: "gate.ContentType",
          executionOrder: 1,
          scope: {
            kind: "sql",
            predicate:
              "[contentTypeId] IN (SELECT DISTINCT [contentTypeId] FROM [gate].[Content] WHERE [contentId] IN ({ids}))",
          },
          scd2Override: null,
          verified: true,
          archiveTable: null,
          note: "Predicate unresolved from legacy pipeline variable @contentTypeIds.",
          provenance: { kind: "manual" },
          scopeColumn: "contentTypeId",
          source: "pipeline-only",
          groundedByPipeline: true,
          enabledByDefault: true,
          userControllable: false,
        },
      ],
    })
    expect(validateEntityExportable(entity).ok).toBe(false)
  })

  it("rejects authored export round-trips that reintroduce review placeholders", () => {
    const source = minimalEntity()
    const authored = {
      schemaVersion: 1,
      id: "sample",
      displayName: "Sample",
      description: "",
      rootTable: "core.Sample",
      idColumn: "sampleId",
      labelColumn: null,
      selfJoinColumn: null,
      legacy: { pipelineId: null, entrySproc: null },
      governance: { approvalPolicyId: null, freezeWindowIds: [] },
      strategy: { strategyId: "mymi-scd2", strategyVersion: "latest" },
      bindings: { serviceProfileRef: "default", environmentPolicyRef: "default" },
      ownership: { team: "sync-platform", owner: null, reviewStatus: "ok", notes: [] },
      metadata: {
        tables: [
          {
            name: "core.Sample",
            scopeColumn: "sampleId",
            predicate: "sampleId IN (/* review placeholder */)",
            source: "manual",
            verified: true,
            groundedByPipeline: false,
            enabledByDefault: true,
            userControllable: false,
          },
        ],
        executionOrder: ["core.Sample"],
        reverseOrder: [],
        discrepancies: [],
      },
      executionFlow: { steps: [{ kind: "metadataSync" }] },
      provenance: { kind: "manual", sourceArtifact: null, sourceVersion: null },
    } satisfies AuthoredSyncDefinition

    const result = validateAuthoredExportRoundTrip(source, authored)
    expect(result.ok).toBe(false)
    expect(entityDefinitionFromAuthoredSync(authored, "_default")).toBeTruthy()
  })
})
