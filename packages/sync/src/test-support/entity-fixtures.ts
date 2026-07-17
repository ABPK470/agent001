/**
 * Minimal published-definition shapes for multi-entity sync tests.
 * Mirrors production entity topology without hardcoding orchestrator logic.
 */

import { buildMinimalTestFlowCatalog } from "../domain/test-flow-catalog.js"
import type { AuthoredSyncFlowStep } from "@mia/shared-types"

export interface EntityTableFixture {
  name: string
  scopeColumn: string | null
  predicate: string
  userControllable?: boolean
}

export interface EntityFixtureSpec {
  id: string
  rootTable: string
  idColumn: string
  labelColumn: string | null
  selfJoinColumn?: string | null
  tables: EntityTableFixture[]
  executionOrder: string[]
}

export const ENTITY_SPECS: Record<string, EntityFixtureSpec> = {
  contract: {
    id: "contract",
    rootTable: "core.Contract",
    idColumn: "contractId",
    labelColumn: "name",
    tables: [
      { name: "core.Contract", scopeColumn: "contractId", predicate: "contractId = {id}" },
      { name: "core.ContractColumn", scopeColumn: "contractId", predicate: "contractId = {id}" },
      { name: "core.Dataset", scopeColumn: "contractId", predicate: "contractId = {id}" },
      { name: "core.Pipeline", scopeColumn: "contractId", predicate: "contractId = {id}" },
      {
        name: "core.DatasetMapping",
        scopeColumn: "datasetId_Left",
        predicate: "datasetId_Left IN (SELECT datasetId FROM [core].[Dataset] WHERE contractId = {id})"
      },
      {
        name: "core.Activity",
        scopeColumn: "pipelineId",
        predicate: "pipelineId IN (SELECT pipelineId FROM [core].[Pipeline] WHERE contractId = {id})"
      },
      {
        name: "core.Step",
        scopeColumn: null,
        predicate:
          "EXISTS (SELECT 1 FROM [core].[Pipeline] p WHERE p.pipelineId = [core].[Step].pipelineId AND p.contractId = {id})",
        userControllable: true
      }
    ],
    executionOrder: [
      "core.Contract",
      "core.ContractColumn",
      "core.Dataset",
      "core.DatasetMapping",
      "core.Pipeline",
      "core.Activity",
      "core.Step"
    ]
  },
  dataset: {
    id: "dataset",
    rootTable: "core.Dataset",
    idColumn: "datasetId",
    labelColumn: "name",
    selfJoinColumn: "parentDatasetId",
    tables: [
      { name: "core.Dataset", scopeColumn: "datasetId", predicate: "datasetId = {id}" },
      { name: "core.DatasetColumn", scopeColumn: "datasetId", predicate: "datasetId = {id}" },
      {
        name: "core.DatasetMapping",
        scopeColumn: "datasetMappingId",
        predicate:
          "datasetMappingId IN (SELECT datasetMappingId FROM [core].[DatasetMapping] WHERE datasetId_Left IN ({id}))"
      },
      {
        name: "core.Pipeline",
        scopeColumn: "pipelineId",
        predicate: "pipelineId IN (SELECT pipelineId FROM [core].[Pipeline] WHERE datasetId IN ({id}))"
      }
    ],
    executionOrder: ["core.Dataset", "core.DatasetColumn", "core.DatasetMapping", "core.Pipeline"]
  },
  rule: {
    id: "rule",
    rootTable: "core.Rule",
    idColumn: "ruleId",
    labelColumn: "name",
    tables: [
      { name: "core.Rule", scopeColumn: "ruleId", predicate: "ruleId = {id}" },
      { name: "core.RuleColumn", scopeColumn: null, predicate: "EXISTS (SELECT 1 FROM [core].[Rule] r WHERE r.ruleId = {id})" },
      {
        name: "core.DatasetMapping",
        scopeColumn: "datasetMappingId",
        predicate: "datasetMappingId IN (SELECT datasetMappingId FROM [core].[DatasetMapping] WHERE datasetId_Left IN ({id}))"
      }
    ],
    executionOrder: ["core.Rule", "core.RuleColumn", "core.DatasetMapping"]
  },
  pipelineActivity: {
    id: "pipelineActivity",
    rootTable: "core.Pipeline",
    idColumn: "pipelineId",
    labelColumn: "name",
    tables: [
      { name: "core.Pipeline", scopeColumn: "pipelineId", predicate: "pipelineId = {id}" },
      { name: "core.Activity", scopeColumn: "pipelineId", predicate: "pipelineId = {id}" },
      {
        name: "core.Step",
        scopeColumn: "pipelineId",
        predicate: "pipelineId = {id}",
        userControllable: true,
      },
    ],
    executionOrder: ["core.Pipeline", "core.Activity", "core.Step"],
  },
  content: {
    id: "content",
    rootTable: "gate.Content",
    idColumn: "contentId",
    labelColumn: "name",
    tables: [
      { name: "gate.Content", scopeColumn: "contentId", predicate: "contentId = {id}" }
    ],
    executionOrder: ["gate.Content"]
  },
  gateMetadata: {
    id: "gateMetadata",
    rootTable: "gate.MetaTable",
    idColumn: "tableId",
    labelColumn: "name",
    tables: [
      { name: "gate.MetaTable", scopeColumn: "tableId", predicate: "tableId = {id}" },
    ],
    executionOrder: ["gate.MetaTable"],
  },
}

export function publishedDefinitionFromSpec(spec: EntityFixtureSpec): Record<string, unknown> {
  const steps: AuthoredSyncFlowStep[] = [
    {
      id: "metadataSync",
      phase: "metadata",
      kind: "metadataSync",
      title: "Metadata sync",
      description: "Apply metadata",
    },
  ]
  const catalog = buildMinimalTestFlowCatalog().snapForSteps(steps)
  return {
    schemaVersion: 1,
    id: spec.id,
    displayName: spec.id,
    description: `test fixture ${spec.id}`,
    rootTable: spec.rootTable,
    idColumn: spec.idColumn,
    labelColumn: spec.labelColumn,
    selfJoinColumn: spec.selfJoinColumn ?? null,
    legacy: { pipelineId: null, entrySproc: null },
    governance: { freezeWindowIds: [] },
    strategy: { strategyId: "mymi-scd2", strategyVersion: "latest" },
    bindings: { serviceProfileRef: "default", environmentPolicyRef: "default" },
    ownership: { team: "test", owner: null, reviewStatus: "reviewed", notes: [] },
    metadata: {
      tables: spec.tables.map((t) => ({
        name: t.name,
        scopeColumn: t.scopeColumn,
        predicate: t.predicate,
        source: "manual",
        verified: true,
        groundedByPipeline: false,
        enabledByDefault: !t.userControllable,
        userControllable: Boolean(t.userControllable)
      })),
      executionOrder: spec.executionOrder,
      reverseOrder: [...spec.executionOrder].reverse(),
      discrepancies: []
    },
    executionFlow: { steps, catalog },
    provenance: { kind: "manual" },
    publishedAt: "2026-01-01T00:00:00.000Z",
    publishedVersion: "test-v1"
  }
}

import { mkdirSync, writeFileSync, utimesSync } from "node:fs"
import { join } from "node:path"

export function writeEntityBundle(
  projectRoot: string,
  entityIds: Array<keyof typeof ENTITY_SPECS | string>
): void {
  mkdirSync(join(projectRoot, "sync-definitions", "published"), { recursive: true })
  const definitions = Object.fromEntries(
    entityIds.map((id) => {
      const spec = ENTITY_SPECS[id as string]
      if (!spec) throw new Error(`Unknown entity fixture: ${id}`)
      return [spec.id, publishedDefinitionFromSpec(spec)]
    })
  )
  const file = join(projectRoot, "sync-definitions", "published", "definitions.bundle.json")
  writeFileSync(
    file,
    JSON.stringify(
      { version: 1, publishedAt: "2026-01-01", publishedVersion: "test-v1", definitions },
      null,
      2
    )
  )
  const now = Date.now()
  utimesSync(file, new Date(now), new Date(now))
}
