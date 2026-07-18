/**
 * Legacy refresh golden builders — Phase 0 lock for catalog shape unification.
 *
 * G1 = native seed wire (EntityDefinition entities + sync-definition-configs + shared catalog files)
 * G2 = logical catalog (entities + configs + metadata) — equals G1 entities/configs after stamp normalize
 * G3 = Publish compose (SyncDefinition) minus publishedAt/publishedVersion
 *
 * Historical Authored wire lives at g1-authored-historical.json for A→B conversion tests only.
 * Volatile fields: G2 uses a fixed createdAt; Authored historical normalizes provenance.sourceVersion.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import type {
  AuthoredSyncDefinition,
  PublishedSyncDefinition,
  Scd2Strategy,
} from "@mia/shared-types"

import {
  compilePublishedSyncDefinition,
  type SyncDefinitionConfigInput,
} from "../domain/compile-sync-definition.js"
import { buildFlowCatalog, type FlowCatalog } from "../domain/flow-catalog.js"
import type { EntityDefinition } from "../domain/entity-registry/types.js"
import {
  defaultSyncDefinitionFlowTemplateId,
  getSyncDefinitionFlowTemplateSteps,
  type SyncDefinitionFlowTemplateCatalog,
} from "../domain/sync-definition-flow-templates.js"
import { loadSyncDefinitionFlowTemplateCatalog } from "../runtime/load-flow-templates.js"

export const LEGACY_REFRESH_SEED_CREATED_AT = "2026-01-01T00:00:00.000Z"
export const LEGACY_REFRESH_PUBLISH_STAMP = "2026-01-01T00:00:00.000Z"

export const ENTITY_IDS = [
  "content",
  "contract",
  "dataset",
  "gateMetadata",
  "pipelineActivity",
  "rule",
] as const

export type LegacyRefreshEntityId = (typeof ENTITY_IDS)[number]

export type SeedRunConfig = {
  entityId: string
  flowPreset: string
  serviceProfileRef: string
  environmentPolicyRef: string
  ownershipTeam: string
  ownershipOwner: string | null
  reviewStatus: "legacy-review-required" | "reviewed"
  ownershipNotes: string[]
}

export type LogicalCatalogGolden = {
  entities: Record<string, EntityDefinition>
  configs: Record<string, SeedRunConfig>
  syncMetadata: unknown
  strategies: unknown
  environments: unknown
  flowTemplates: unknown
}

export type PublishedCatalogGolden = {
  definitions: Record<string, Omit<PublishedSyncDefinition, "publishedAt" | "publishedVersion">>
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8")) as unknown
}

/** Detect Authored seed (Format A) vs EntityDefinition seed. */
export function isAuthoredSyncDefinitionSeed(raw: unknown): raw is AuthoredSyncDefinition {
  if (!raw || typeof raw !== "object") return false
  const doc = raw as Record<string, unknown>
  const metadata = doc["metadata"]
  return (
    typeof doc["schemaVersion"] === "number" &&
    metadata !== null &&
    typeof metadata === "object" &&
    Array.isArray((metadata as { tables?: unknown }).tables)
  )
}

export function isEntityDefinitionSeed(raw: unknown): raw is EntityDefinition {
  if (!raw || typeof raw !== "object") return false
  const doc = raw as Record<string, unknown>
  return Array.isArray(doc["tables"]) && typeof doc["rootTable"] === "string" && !isAuthoredSyncDefinitionSeed(raw)
}

export function loadShippedEntityDefinitionSeeds(projectRoot: string): Record<string, EntityDefinition> {
  const dir = resolve(projectRoot, "deploy/sync/artifacts/entities")
  const out: Record<string, EntityDefinition> = {}
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
    const raw = readJson(join(dir, file))
    if (!isEntityDefinitionSeed(raw)) {
      throw new Error(`Expected EntityDefinition seed at ${file}`)
    }
    out[raw.id] = raw
  }
  return out
}

export type G1NativeWireGolden = {
  entities: Record<string, EntityDefinition>
  configs: Record<string, SeedRunConfig>
  syncMetadata: unknown
  strategies: unknown
  environments: unknown
  flowTemplates: unknown
}

/** Native EntityDefinition seed wire (current git authoring format). */
export function buildG1WireGolden(projectRoot: string): G1NativeWireGolden {
  const logical = buildG2LogicalFromNativeSeeds(projectRoot)
  return {
    entities: logical.entities,
    configs: logical.configs,
    syncMetadata: logical.syncMetadata,
    strategies: logical.strategies,
    environments: logical.environments,
    flowTemplates: logical.flowTemplates,
  }
}

export function seedRunConfigFromAuthored(
  authored: AuthoredSyncDefinition,
  flowTemplateCatalog: SyncDefinitionFlowTemplateCatalog,
): SeedRunConfig {
  const flowPreset = defaultSyncDefinitionFlowTemplateId(authored.id, flowTemplateCatalog)
  return {
    entityId: authored.id,
    flowPreset,
    serviceProfileRef: authored.bindings?.serviceProfileRef ?? "default",
    environmentPolicyRef: authored.bindings?.environmentPolicyRef ?? "default",
    ownershipTeam: authored.ownership?.team ?? "sync-platform",
    ownershipOwner: authored.ownership?.owner ?? null,
    reviewStatus: authored.ownership?.reviewStatus ?? "legacy-review-required",
    ownershipNotes: authored.ownership?.notes ?? ["Bootstrapped from legacy pipeline ground truth."],
  }
}

export function configInputFromSeedRun(config: SeedRunConfig, flowTemplateCatalog: SyncDefinitionFlowTemplateCatalog): SyncDefinitionConfigInput {
  return {
    flow_preset: config.flowPreset,
    execution_steps_json: JSON.stringify(
      getSyncDefinitionFlowTemplateSteps(flowTemplateCatalog, config.flowPreset as never),
    ),
    service_profile_ref: config.serviceProfileRef,
    environment_policy_ref: config.environmentPolicyRef,
    ownership_team: config.ownershipTeam,
    ownership_owner: config.ownershipOwner,
    review_status: config.reviewStatus,
    ownership_notes_json: JSON.stringify(config.ownershipNotes),
  }
}

export function buildFlowCatalogFromSyncMetadataFile(projectRoot: string): FlowCatalog {
  const meta = readJson(resolve(projectRoot, "deploy/sync/artifacts/sync-metadata.json")) as {
    phases?: Array<{ id: string; label: string; definition: unknown }>
    actions?: Array<{ id: string; label: string; definition: unknown }>
    valueSources?: Array<{ id: string; label: string; definition: unknown }>
  }
  return buildFlowCatalog(
    (meta.phases ?? []).map((phase) => ({
      id: phase.id,
      label: phase.label,
      definition_json: JSON.stringify(phase.definition),
    })),
    (meta.actions ?? []).map((action) => ({
      id: action.id,
      label: action.label,
      definition_json: JSON.stringify(action.definition),
    })),
    (meta.valueSources ?? []).map((source) => ({
      id: source.id,
      label: source.label,
      definition_json: JSON.stringify(source.definition),
    })),
  )
}

function loadStrategyResolver(projectRoot: string): (strategyId: string, strategyVersion: number | "latest") => Scd2Strategy | null {
  const doc = readJson(resolve(projectRoot, "deploy/sync/artifacts/strategies.json")) as {
    strategies: Scd2Strategy[]
  }
  const byId = new Map(doc.strategies.map((s) => [s.id, s]))
  return (strategyId) => byId.get(strategyId) ?? null
}

export function stripPublishStamps(
  published: PublishedSyncDefinition,
): Omit<PublishedSyncDefinition, "publishedAt" | "publishedVersion"> {
  const { publishedAt: _a, publishedVersion: _v, ...rest } = published
  return rest
}

export function buildG3PublishedFromLogical(
  projectRoot: string,
  logical: LogicalCatalogGolden,
): PublishedCatalogGolden {
  const flowTemplateCatalog = loadSyncDefinitionFlowTemplateCatalog(projectRoot)
  const flowCatalog = buildFlowCatalogFromSyncMetadataFile(projectRoot)
  const resolveStrategy = loadStrategyResolver(projectRoot)
  const definitions: PublishedCatalogGolden["definitions"] = {}
  for (const id of Object.keys(logical.entities).sort()) {
    const entity = logical.entities[id]!
    const seedConfig = logical.configs[id]!
    const published = compilePublishedSyncDefinition(
      entity,
      configInputFromSeedRun(seedConfig, flowTemplateCatalog),
      flowTemplateCatalog,
      flowCatalog,
      LEGACY_REFRESH_PUBLISH_STAMP,
      LEGACY_REFRESH_PUBLISH_STAMP,
      resolveStrategy,
    )
    definitions[id] = stripPublishStamps(published)
  }
  return { definitions }
}

export function buildG2LogicalFromNativeSeeds(projectRoot: string): LogicalCatalogGolden {
  const entities = loadShippedEntityDefinitionSeeds(projectRoot)
  for (const entity of Object.values(entities)) {
    entity.createdAt = LEGACY_REFRESH_SEED_CREATED_AT
  }
  const configsPath = resolve(projectRoot, "deploy/sync/artifacts/sync-definition-configs.json")
  if (!existsSync(configsPath)) {
    throw new Error("Missing deploy/sync/artifacts/sync-definition-configs.json")
  }
  const configsDoc = readJson(configsPath) as {
    configs: SeedRunConfig[]
  }
  const configs: Record<string, SeedRunConfig> = {}
  for (const row of configsDoc.configs) {
    configs[row.entityId] = row
  }
  for (const id of Object.keys(entities)) {
    if (!configs[id]) throw new Error(`Missing sync-definition-configs entry for ${id}`)
  }
  return {
    entities,
    configs,
    syncMetadata: readJson(resolve(projectRoot, "deploy/sync/artifacts/sync-metadata.json")),
    strategies: readJson(resolve(projectRoot, "deploy/sync/artifacts/strategies.json")),
    environments: readJson(resolve(projectRoot, "deploy/sync/sync-environments.json")),
    flowTemplates: readJson(resolve(projectRoot, "deploy/sync/artifacts/flow-templates.json")),
  }
}

export function goldenDir(projectRoot: string): string {
  return resolve(projectRoot, "packages/sync/src/test-support/__goldens__/legacy-refresh")
}
