/**
 * Import deploy catalog snapshots into SQLite (never writes repo seeds or .env).
 *
 * Mirror of export-deploy-artifacts — single replace path from validated snapshot.
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

import type { AuthoredSyncFlowStep } from "@mia/shared-types"
import type { Scd2Strategy, SyncEnvironment } from "@mia/sync"
import { validateEntityDefinition } from "@mia/sync"
import { defaultSyncDefinitionFlowTemplateId, hasSyncDefinitionFlowTemplate, withPermissionDefaults } from "@mia/sync"
import { validateCatalogId } from "@mia/shared-types"

import * as db from "../../../platform/persistence/sqlite.js"
import { getDb } from "../../../platform/persistence/sqlite.js"
import {
  buildFlowCatalogFromSyncMetadataDoc,
  FlowStepsValidationError,
  prepareFlowStepsForStorage,
  validateFlowStepsForCatalog,
} from "../../sync/domain/flow-steps.js"
import { applyEntityRunYaml } from "../../sync/application/apply-entity-run-yaml.js"
import {
  ensureSyncDefinitionConfigs,
  loadAuthoringFlowCatalog,
  rehydrateSyncDefinitionConfigSteps,
  upsertSyncDefinitionConfig,
} from "../../sync/application/definitions.js"
import {
  buildEntityRegistryExportDocument,
  parseEntitiesJson,
  type EntityRegistryExportDocument,
} from "../../sync/domain/entity-yaml.js"
import type { DeployCatalogSnapshot, SyncDefinitionConfigExportDocument } from "./export-deploy-artifacts.js"

const DEFAULT_TENANT = "_default"

export interface CatalogImportSectionCounts {
  environments: number
  phases: number
  stepTypes: number
  wiring: number
  flows: number
  strategies: number
  entities: number
}

export interface CatalogImportPreview {
  ok: boolean
  errors: string[]
  counts: CatalogImportSectionCounts
}

export interface CatalogImportResult extends CatalogImportPreview {
  dryRun: boolean
  applied: boolean
}

type SyncMetadataDoc = {
  version?: number
  phases?: Array<{ id: string; label: string; sortOrder: number; definition: unknown }>
  stepTypes?: Array<{ id: string; label: string; definition: unknown }>
  customValueSources?: Array<{ id: string; label: string; definition: unknown }>
  flows?: Record<string, { label: string; description?: string; steps: AuthoredSyncFlowStep[] }>
}

type StrategiesDoc = {
  version?: number
  strategies?: Scd2Strategy[]
}

type EnvironmentsDoc = {
  version?: number
  environments?: Array<Record<string, unknown>>
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8")) as unknown
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

/** Read an export-layout folder into a DeployCatalogSnapshot. */
export function parseCatalogBundleFromDir(bundleDir: string): DeployCatalogSnapshot {
  const root = resolve(bundleDir)
  const manifest = requireObject(readJsonFile(join(root, "manifest.json")), "manifest.json")
  const syncMetadata = requireObject(
    readJsonFile(join(root, "artifacts", "sync-metadata.json")),
    "artifacts/sync-metadata.json",
  )
  const strategies = requireObject(
    readJsonFile(join(root, "artifacts", "strategies.json")),
    "artifacts/strategies.json",
  )
  const flowTemplates = requireObject(
    readJsonFile(join(root, "artifacts", "flow-templates.json")),
    "artifacts/flow-templates.json",
  )
  const environments = requireObject(readJsonFile(join(root, "sync-environments.json")), "sync-environments.json")

  let entityRegistry: EntityRegistryExportDocument | null = null
  const entityPath = join(root, "artifacts", "entity-registry.json")
  try {
    const raw = requireObject(readJsonFile(entityPath), "artifacts/entity-registry.json")
    entityRegistry = raw as unknown as EntityRegistryExportDocument
  } catch {
    entityRegistry = null
  }

  let syncDefinitionConfigs: SyncDefinitionConfigExportDocument | null = null
  const configPath = join(root, "artifacts", "sync-definition-configs.json")
  try {
    const raw = requireObject(readJsonFile(configPath), "artifacts/sync-definition-configs.json")
    syncDefinitionConfigs = raw as unknown as SyncDefinitionConfigExportDocument
  } catch {
    syncDefinitionConfigs = null
  }

  const entityIds = Array.isArray(manifest.entityIds)
    ? (manifest.entityIds as string[])
    : entityRegistry?.entities?.map((entry) => String((entry as { id?: string }).id ?? "")).filter(Boolean) ?? []

  return {
    exportedAt: typeof manifest.exportedAt === "string" ? manifest.exportedAt : new Date().toISOString(),
    tenantId: typeof manifest.tenantId === "string" ? manifest.tenantId : DEFAULT_TENANT,
    syncMetadata,
    flowTemplates,
    strategies,
    environments,
    entityRegistry,
    syncDefinitionConfigs,
    entityIds,
  }
}

/** Locate export bundle root (zip may contain a single top-level folder). */
function resolveBundleRoot(extractedDir: string): string {
  const directManifest = join(extractedDir, "manifest.json")
  if (existsSync(directManifest)) return extractedDir
  for (const entry of readdirSync(extractedDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(extractedDir, entry.name)
    if (existsSync(join(candidate, "manifest.json"))) return candidate
  }
  throw new Error("manifest.json not found in import bundle")
}

/** Extract a catalog bundle zip buffer into a temp folder and parse it. */
export function parseCatalogZipBuffer(buffer: Buffer): DeployCatalogSnapshot {
  const parent = mkdtempSync(join(tmpdir(), "mia-import-"))
  const zipPath = join(parent, "bundle.zip")
  writeFileSync(zipPath, buffer)
  const unzip = spawnSync("unzip", ["-q", zipPath], { cwd: parent, encoding: "utf-8" })
  if (unzip.status !== 0) {
    rmSync(parent, { recursive: true, force: true })
    throw new Error("Zip import is unavailable on this host (install the `unzip` CLI).")
  }
  try {
    return parseCatalogBundleFromDir(resolveBundleRoot(parent))
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

export function validateDeployCatalogSnapshot(snapshot: DeployCatalogSnapshot): CatalogImportPreview {
  const errors: string[] = []
  const counts: CatalogImportSectionCounts = {
    environments: 0,
    phases: 0,
    stepTypes: 0,
    wiring: 0,
    flows: 0,
    strategies: 0,
    entities: 0,
  }

  const envDoc = snapshot.environments as EnvironmentsDoc
  if (!Array.isArray(envDoc.environments)) {
    errors.push("sync-environments.json: environments array is required")
  } else {
    counts.environments = envDoc.environments.length
  }

  const meta = snapshot.syncMetadata as SyncMetadataDoc
  if (!Array.isArray(meta.phases)) errors.push("sync-metadata.json: phases array is required")
  else counts.phases = meta.phases.length
  if (!Array.isArray(meta.stepTypes)) errors.push("sync-metadata.json: stepTypes array is required")
  else counts.stepTypes = meta.stepTypes.length
  counts.wiring = Array.isArray(meta.customValueSources) ? meta.customValueSources.length : 0
  counts.flows = meta.flows && typeof meta.flows === "object" ? Object.keys(meta.flows).length : 0
  if (counts.flows === 0) errors.push("sync-metadata.json: flows object is required")

  for (const stepType of meta.stepTypes ?? []) {
    const idError = validateCatalogId(stepType.id, "Kind id")
    if (idError) errors.push(`sync-metadata.json stepTypes: ${idError}`)
  }
  for (const source of meta.customValueSources ?? []) {
    const idError = validateCatalogId(source.id, "Custom value source id")
    if (idError) errors.push(`sync-metadata.json customValueSources: ${idError}`)
  }

  const flowCatalog =
    errors.length === 0 ? buildFlowCatalogFromSyncMetadataDoc(meta) : null
  for (const [flowId, flow] of Object.entries(meta.flows ?? {})) {
    const flowIdError = validateCatalogId(flowId, "Flow id")
    if (flowIdError) {
      errors.push(`sync-metadata.json flows: ${flowIdError}`)
      continue
    }
    if (!flowCatalog) continue
    const flowError = validateFlowStepsForCatalog(flow.steps ?? [], flowCatalog)
    if (flowError) errors.push(`sync-metadata.json flow "${flowId}": ${flowError}`)
  }

  const flowIds = new Set(Object.keys(meta.flows ?? {}))
  flowIds.add("metadataOnly")

  const validateFlowPreset = (entityId: string, flowPreset: string): void => {
    if (!flowPreset.trim()) {
      errors.push(`entity "${entityId}": flow reference is required`)
      return
    }
    if (!flowIds.has(flowPreset)) {
      errors.push(
        `entity "${entityId}": unknown flow "${flowPreset}". Define it under Configuration → Flows.`,
      )
    }
  }

  if (snapshot.syncDefinitionConfigs?.configs) {
    for (const config of snapshot.syncDefinitionConfigs.configs) {
      validateFlowPreset(config.entityId, config.flowPreset)
    }
  }

  const strategiesDoc = snapshot.strategies as StrategiesDoc
  if (!Array.isArray(strategiesDoc.strategies)) {
    errors.push("strategies.json: strategies array is required")
  } else {
    counts.strategies = strategiesDoc.strategies.length
  }

  if (snapshot.entityRegistry?.entities) {
    counts.entities = snapshot.entityRegistry.entities.length
    for (const entry of snapshot.entityRegistry.entities) {
      const parsed = parseEntitiesJson(JSON.stringify(entry))
      for (const item of parsed) {
        if (!item.ok) {
          errors.push(`entity ${item.error}`)
          continue
        }
        if (item.def) {
          const validation = validateEntityDefinition({
            ...item.def,
            tenantId: item.def.tenantId || DEFAULT_TENANT,
          })
          if (!validation.ok) {
            for (const issue of validation.errors) {
              errors.push(`entity "${item.def.id}": ${issue.message}`)
            }
          }
        }
        if (item.run) validateFlowPreset(String(item.def?.id ?? "unknown"), item.run.template)
      }
    }
  }

  return { ok: errors.length === 0, errors, counts }
}

function applyEnvironments(doc: EnvironmentsDoc): number {
  const environments = doc.environments ?? []
  const names = new Set<string>()

  for (const raw of environments) {
    const name = typeof raw.name === "string" ? raw.name.trim() : ""
    if (!name) throw new Error("sync-environments.json: each environment requires name")
    names.add(name)
    const env = withPermissionDefaults({
      name,
      displayName: String(raw.displayName ?? name),
      color: String(raw.color ?? "slate"),
      role: (raw.role as SyncEnvironment["role"]) ?? "both",
      ringOrder: Number(raw.ringOrder ?? 0),
      agentServiceBaseUrl: (raw.agentServiceBaseUrl as string | null) ?? null,
      etlServiceBaseUrl: (raw.etlServiceBaseUrl as string | null) ?? null,
      gateServiceBaseUrl: (raw.gateServiceBaseUrl as string | null) ?? null,
      serviceUrls:
        raw.serviceUrls && typeof raw.serviceUrls === "object" && !Array.isArray(raw.serviceUrls)
          ? (raw.serviceUrls as Record<string, string | null>)
          : undefined,
      defaultAccessMode: (raw.defaultAccessMode as SyncEnvironment["defaultAccessMode"]) ?? "read_write",
      allowedOperations: (raw.allowedOperations as SyncEnvironment["allowedOperations"]) ?? undefined,
      denyDml: Boolean(raw.denyDml),
      denyDdl: Boolean(raw.denyDdl),
      approvalRequiredOperations:
        (raw.approvalRequiredOperations as SyncEnvironment["approvalRequiredOperations"]) ?? [],
      allowedSyncTargets: Array.isArray(raw.allowedSyncTargets)
        ? raw.allowedSyncTargets.map(String)
        : [],
    })
    const now = new Date().toISOString()
    const existing = db.getSyncEnvironment(name)
    db.saveSyncEnvironment({
      name,
      body_json: JSON.stringify(env),
      created_at: existing?.created_at ?? now,
      updated_at: now,
      updated_by: "catalog-import",
    })
  }

  for (const row of db.listSyncEnvironments()) {
    if (!names.has(row.name)) db.deleteSyncEnvironment(row.name)
  }

  return environments.length
}

function applySyncMetadata(tenantId: string, doc: SyncMetadataDoc): void {
  const phases = doc.phases ?? []
  const stepTypes = doc.stepTypes ?? []
  const wiring = doc.customValueSources ?? []
  const flows = doc.flows ?? {}
  const flowCatalog = buildFlowCatalogFromSyncMetadataDoc(doc)

  const phaseIds = new Set(phases.map((p) => p.id))
  const kindIds = new Set(stepTypes.map((k) => k.id))
  const wiringIds = new Set(wiring.map((w) => w.id))
  const flowIds = new Set(Object.keys(flows))

  for (const phase of phases) {
    const existing = db.listSyncRunPhases(tenantId).find((row) => row.id === phase.id)
    db.saveSyncRunPhase({
      tenant_id: tenantId,
      id: phase.id,
      label: phase.label,
      sort_order: phase.sortOrder,
      built_in: existing?.built_in ?? 1,
      definition_json: JSON.stringify(phase.definition),
    })
  }
  for (const row of db.listSyncRunPhases(tenantId)) {
    if (!phaseIds.has(row.id) && row.built_in === 0) db.deleteSyncRunPhase(tenantId, row.id)
  }

  for (const stepType of stepTypes) {
    const existing = db.listSyncRunKinds(tenantId).find((row) => row.id === stepType.id)
    db.saveSyncRunKind({
      tenant_id: tenantId,
      id: stepType.id,
      label: stepType.label,
      built_in: existing?.built_in ?? 1,
      definition_json: JSON.stringify(stepType.definition),
    })
  }
  for (const row of db.listSyncRunKinds(tenantId)) {
    if (!kindIds.has(row.id) && row.built_in === 0) db.deleteSyncRunKind(tenantId, row.id)
  }

  for (const source of wiring) {
    const existing = db.listSyncRunBindingSources(tenantId).find((row) => row.id === source.id)
    db.saveSyncRunBindingSource({
      tenant_id: tenantId,
      id: source.id,
      label: source.label,
      built_in: existing?.built_in ?? 1,
      definition_json: JSON.stringify(source.definition),
    })
  }
  for (const row of db.listSyncRunBindingSources(tenantId)) {
    if (!wiringIds.has(row.id) && row.built_in === 0) db.deleteSyncRunBindingSource(tenantId, row.id)
  }

  for (const [id, flow] of Object.entries(flows)) {
    const existing = db.getSyncRunPreset(tenantId, id)
    let stepsJson: string
    try {
      stepsJson = JSON.stringify(prepareFlowStepsForStorage(flow.steps ?? [], flowCatalog))
    } catch (error) {
      const message = error instanceof FlowStepsValidationError ? error.message : String(error)
      throw new Error(`sync-metadata.json flow "${id}": ${message}`)
    }
    db.saveSyncRunPreset({
      tenant_id: tenantId,
      id,
      label: flow.label,
      description: flow.description ?? "",
      steps_json: stepsJson,
      built_in: existing?.built_in ?? 1,
      updated_at: new Date().toISOString(),
      updated_by: "catalog-import",
    })
  }
  for (const row of db.listSyncRunPresets(tenantId)) {
    if (!flowIds.has(row.id) && row.built_in === 0) db.deleteSyncRunPreset(tenantId, row.id)
  }
}

function applyStrategies(tenantId: string, doc: StrategiesDoc, actor: string): void {
  for (const strategy of doc.strategies ?? []) {
    db.saveScd2Strategy({
      tenantId,
      strategy,
      actor,
      reason: "catalog-import",
    })
  }
}

function applySyncDefinitionConfigs(
  tenantId: string,
  doc: SyncDefinitionConfigExportDocument | null,
  projectRoot: string,
  actor: string,
): number {
  if (!doc?.configs?.length) return 0
  const flowTemplateCatalog = loadAuthoringFlowCatalog(projectRoot, tenantId)
  const importedIds = new Set(doc.configs.map((config) => config.entityId))
  for (const row of db.listSyncDefinitionConfigs(tenantId)) {
    if (!importedIds.has(row.entity_id)) {
      db.deleteSyncDefinitionConfig(tenantId, row.entity_id)
    }
  }
  const now = new Date().toISOString()
  for (const config of doc.configs) {
    const flowPreset = hasSyncDefinitionFlowTemplate(flowTemplateCatalog, config.flowPreset)
      ? config.flowPreset
      : defaultSyncDefinitionFlowTemplateId(config.entityId, flowTemplateCatalog)
    upsertSyncDefinitionConfig(projectRoot, {
      tenant_id: tenantId,
      entity_id: config.entityId,
      flow_preset: flowPreset,
      execution_steps_json: "[]",
      service_profile_ref: config.serviceProfileRef,
      environment_policy_ref: config.environmentPolicyRef,
      ownership_team: config.ownershipTeam,
      ownership_owner: config.ownershipOwner,
      review_status: config.reviewStatus,
      ownership_notes_json: JSON.stringify(config.ownershipNotes),
      updated_at: now,
      updated_by: actor,
    })
  }
  return doc.configs.length
}

function collectSnapshotEntityIds(snapshot: DeployCatalogSnapshot): Set<string> {
  const ids = new Set<string>()
  for (const id of snapshot.entityIds ?? []) {
    const trimmed = id.trim()
    if (trimmed) ids.add(trimmed)
  }
  for (const entry of snapshot.entityRegistry?.entities ?? []) {
    const parsed = parseEntitiesJson(JSON.stringify(entry))
    for (const item of parsed) {
      if (item.ok && item.def?.id) ids.add(item.def.id)
    }
  }
  return ids
}

function applyEntityDefinitions(
  tenantId: string,
  snapshot: DeployCatalogSnapshot,
  actor: string,
): number {
  const importedIds = collectSnapshotEntityIds(snapshot)
  let count = 0

  for (const entry of snapshot.entityRegistry?.entities ?? []) {
    const parsed = parseEntitiesJson(JSON.stringify(entry))
    for (const item of parsed) {
      if (!item.ok || !item.def) throw new Error(item.error ?? "entity parse failed")
      db.saveEntityDefinition({
        tenantId,
        def: { ...item.def, tenantId },
        actor,
        reason: "catalog-import",
      })
      count++
    }
  }

  // Match environments and sync-definition configs: drop active entities absent from snapshot.
  for (const entity of db.listEntityDefinitions(tenantId, { includeRetired: false })) {
    if (!importedIds.has(entity.id)) {
      db.retireEntityDefinition(tenantId, entity.id, actor)
    }
  }

  return count
}

function applyEntityRunBindings(
  tenantId: string,
  snapshot: DeployCatalogSnapshot,
  actor: string,
  projectRoot: string,
): number {
  let count = 0
  for (const entry of snapshot.entityRegistry?.entities ?? []) {
    const parsed = parseEntitiesJson(JSON.stringify(entry))
    for (const item of parsed) {
      if (!item.ok || !item.run) continue
      applyEntityRunYaml(projectRoot, tenantId, item.def!.id, item.run, actor)
      count++
    }
  }
  return count
}

export function applyDeployCatalogSnapshot(args: {
  snapshot: DeployCatalogSnapshot
  actor: string
  projectRoot?: string
  dryRun?: boolean
}): CatalogImportResult {
  const preview = validateDeployCatalogSnapshot(args.snapshot)
  if (!preview.ok || args.dryRun) {
    return { ...preview, dryRun: true, applied: false }
  }

  if (!args.projectRoot) {
    return {
      ...preview,
      ok: false,
      dryRun: false,
      applied: false,
      errors: [...preview.errors, "projectRoot is required to apply catalog import"],
    }
  }

  const tenantId = args.snapshot.tenantId || DEFAULT_TENANT

  getDb().transaction(() => {
    applyEnvironments(args.snapshot.environments as EnvironmentsDoc)
    applySyncMetadata(tenantId, args.snapshot.syncMetadata as SyncMetadataDoc)
    applyStrategies(tenantId, args.snapshot.strategies as StrategiesDoc, args.actor)
    applyEntityDefinitions(tenantId, args.snapshot, args.actor)
    applySyncDefinitionConfigs(
      tenantId,
      args.snapshot.syncDefinitionConfigs,
      args.projectRoot,
      args.actor,
    )
    applyEntityRunBindings(tenantId, args.snapshot, args.actor, args.projectRoot)
    ensureSyncDefinitionConfigs(args.projectRoot, tenantId)
    rehydrateSyncDefinitionConfigSteps(args.projectRoot, tenantId)
  })()

  return { ...preview, dryRun: false, applied: true }
}

/** Build snapshot from a raw API payload (export JSON or assembled files). */
export function normalizeCatalogSnapshotPayload(body: Record<string, unknown>): DeployCatalogSnapshot {
  if (body.snapshot && typeof body.snapshot === "object") {
    return body.snapshot as DeployCatalogSnapshot
  }
  return body as unknown as DeployCatalogSnapshot
}

export { buildEntityRegistryExportDocument }

/** Apply platform-wide files from a deploy/git export bundle (not entity registry B format). */
export function applyDeployGitPlatformFiles(args: {
  tenantId: string
  actor: string
  syncMetadata: Record<string, unknown>
  strategies: Record<string, unknown>
  environments: Record<string, unknown>
}): { environments: number; strategies: number; flows: number } {
  const meta = args.syncMetadata as SyncMetadataDoc
  const envCount = applyEnvironments(args.environments as EnvironmentsDoc)
  applySyncMetadata(args.tenantId, meta)
  applyStrategies(args.tenantId, args.strategies as StrategiesDoc, args.actor)
  return {
    environments: envCount,
    strategies: (args.strategies as StrategiesDoc).strategies?.length ?? 0,
    flows: meta.flows ? Object.keys(meta.flows).length : 0,
  }
}
