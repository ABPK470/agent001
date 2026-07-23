import { describe, expect, it } from "vitest"
import type { SyncFlowKindDefinition } from "@mia/shared-types"
import type { SyncMetadataArtifact } from "@mia/sync"

import {
  annotateCatalogShippedDrift,
  buildShippedDriftDiff,
  builtInActionDivergedFromShipped,
  builtInFlowDivergedFromShipped,
  builtInValueSourceDivergedFromShipped,
  stableJson,
} from "../src/api/sync/service/catalog-shipped-drift.js"

const emptyKind = (summary: string): SyncFlowKindDefinition => ({
  summary,
  description: summary,
  handler: {
    type: "mssql_procedure",
    connection: "target",
    procedure: "dbo.uspX",
  },
  stepFields: {},
  failureMode: "warning",
})

const metadata: SyncMetadataArtifact = {
  version: 1,
  phases: [
    {
      id: "deploy",
      label: "Deploy",
      sortOrder: 1,
      definition: {
        summary: "Deploy",
        description: "Deploy",
        boundary: "post_metadata",
        connection: "target",
        defaultFailureMode: "warning",
      },
    },
  ],
  actions: [
    {
      id: "metadataSync",
      label: "Metadata sync",
      definition: emptyKind("Metadata sync"),
    },
  ],
  valueSources: [
    {
      id: "planEntityId",
      label: "Plan entity id",
      definition: { description: "Entity id", resolver: { kind: "planEntityId" } },
    },
  ],
  flows: {
    contract: {
      label: "Contract",
      description: "Contract flow",
      steps: [{ id: "meta", kind: "metadataSync" }],
    },
  },
}

describe("catalog-shipped-drift", () => {
  it("stableJson ignores object key order", () => {
    expect(stableJson({ b: 1, a: 2 })).toBe(stableJson({ a: 2, b: 1 }))
  })

  it("marks built-in flows matching shipped as not diverged", () => {
    expect(
      builtInFlowDivergedFromShipped({
        tip: { label: "Contract", description: "Contract flow", steps: [{ id: "meta", kind: "metadataSync" }] },
        shipped: metadata.flows.contract,
        metadata,
      }),
    ).toBe(false)
  })

  it("marks built-in flows with edited steps as diverged", () => {
    expect(
      builtInFlowDivergedFromShipped({
        tip: {
          label: "Contract",
          description: "Contract flow",
          steps: [
            { id: "meta", kind: "metadataSync" },
            { id: "extra", kind: "metadataSync" },
          ],
        },
        shipped: metadata.flows.contract,
        metadata,
      }),
    ).toBe(true)
  })

  it("marks built-in actions with edited labels as diverged", () => {
    expect(
      builtInActionDivergedFromShipped({
        id: "metadataSync",
        tip: { label: "Renamed", definition: emptyKind("Metadata sync") },
        shipped: metadata.actions[0],
      }),
    ).toBe(true)
  })

  it("marks built-in value sources matching shipped as not diverged", () => {
    expect(
      builtInValueSourceDivergedFromShipped({
        id: "planEntityId",
        tip: {
          label: "Plan entity id",
          definition: { description: "Entity id", resolver: { kind: "planEntityId" } },
        },
        shipped: metadata.valueSources![0],
      }),
    ).toBe(false)
  })

  it("annotates catalog rows; customs stay false", () => {
    const annotated = annotateCatalogShippedDrift(
      {
        actions: [
          {
            id: "metadataSync",
            label: "Metadata sync",
            builtIn: true,
            definition: emptyKind("Metadata sync"),
          },
          {
            id: "customAction",
            label: "Custom",
            builtIn: false,
            definition: emptyKind("Custom"),
          },
        ],
        flows: [
          {
            id: "contract",
            label: "Contract edited",
            description: "Contract flow",
            steps: [{ id: "meta", kind: "metadataSync" }],
            builtIn: true,
          },
        ],
        valueSources: [
          {
            id: "planEntityId",
            label: "Plan entity id",
            builtIn: true,
            definition: { description: "Entity id", resolver: { kind: "planEntityId" } },
          },
        ],
      },
      metadata,
    )

    expect(annotated.actions.find((a) => a.id === "metadataSync")?.divergedFromShipped).toBe(false)
    expect(annotated.actions.find((a) => a.id === "customAction")?.divergedFromShipped).toBe(false)
    expect(annotated.flows[0]?.divergedFromShipped).toBe(true)
    expect(annotated.valueSources[0]?.divergedFromShipped).toBe(false)
  })

  it("buildShippedDriftDiff returns tip vs shipped JSON for a modified flow", () => {
    const diff = buildShippedDriftDiff({
      kind: "flows",
      id: "contract",
      tip: {
        label: "Contract edited",
        description: "Contract flow",
        steps: [{ id: "meta", kind: "metadataSync" }],
      },
      metadata,
    })
    expect(diff.diverged).toBe(true)
    expect(diff.shippedJson).toContain('"label": "Contract"')
    expect(diff.tipJson).toContain('"label": "Contract edited"')
  })
})
