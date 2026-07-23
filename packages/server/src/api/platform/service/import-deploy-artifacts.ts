import { parseBoundaryJson } from "../../../internal/parse-json.js"

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
import { asEntityId, asFlowId, asTenantId, validateEntityDefinition } from "@mia/sync"
import { defaultSyncDefinitionFlowTemplateId, hasSyncDefinitionFlowTemplate, withPermissionDefaults } from "@mia/sync"
import { validateCatalogId } from "@mia/shared-types"

import * as db from "../../../infra/persistence/sqlite.js"
import { getDb } from "../../../infra/persistence/sqlite.js"
import {
  buildFlowCatalogFromSyncMetadataDoc,
  FlowStepsValidationError,
  prepareFlowStepsForStorage,
  validateFlowStepsForCatalog,
} from "../../../infra/persistence/sync-flow-steps.js"
import { loadAuthoringFlowCatalog } from "../../sync/service/definitions.js"
import {
  buildEntityRegistryExportDocument,
  parseEntitiesJson,
  type EntityRegistryExportDocument,
} from "../../sync/types/entity-yaml.js"
import type { DeployCatalogSnapshot, SyncDefinitionConfigExportDocument } from "./export-deploy-artifacts.js"

const DEFAULT_TENANT = "_default"

export interface CatalogImportSectionCounts {
  environments: number
  phases: number
  actions: number
  valueSources: number
  flows: number
  strategies: number
  entities: number
  /** @deprecated Use `actions` */
  stepTypes?: number
  /** @deprecated Use `valueSources` */
  wiring?: number
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
  actions?: Array<{ id: string; label: string; definition: unknown }>
  valueSources?: Array<{ id: string; label: string; definition: unknown }>
  /** @deprecated Prefer `actions` */
  stepTypes?: Array<{ id: string; label: string; definition: unknown }>
  /** @deprecated Prefer `valueSources` */
  customValueSources?: Array<{ id: string; label: string; definition: unknown }>
  flows?: Record<string, { label: string; description?: string; steps: AuthoredSyncFlowStep[] }>
}

function docActions(meta: SyncMetadataDoc) {
  return meta.actions ?? meta.stepTypes ?? []
}

function docValueSources(meta: SyncMetadataDoc) {
  return meta.valueSources ?? meta.customValueSources ?? []
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
  return parseBoundaryJson(readFileSync(path, "utf-8")) as unknown
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
  const environments = requireObject(readJsonFile(join(root, "sync-environments.json")), "sync-environments.json")

  const entityRegistry = loadEntityRegistryFromBundle(root)

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
    strategies,
    environments,
    entityRegistry,
    syncDefinitionConfigs,
    entityIds,
  }
}

/** Prefer artifacts/entities/*.json (seed mirror); legacy entity-registry.json accepted. */
function loadEntityRegistryFromBundle(root: string): EntityRegistryExportDocument | null {
  const entitiesDir = join(root, "artifacts", "entities")
  if (existsSync(entitiesDir)) {
    const files = readdirSync(entitiesDir)
      .filter((name) => name.endsWith(".json"))
      .sort()
    if (files.length > 0) {
      const entities: Record<string, unknown>[] = []
      for (const file of files) {
        const raw = requireObject(readJsonFile(join(entitiesDir, file)), `artifacts/entities/${file}`)
        entities.push(raw)
      }
      return {
        version: 1,
        _comment: "Loaded from artifacts/entities/*.json",
        entities,
      }
    }
  }

  const entityPath = join(root, "artifacts", "entity-registry.json")
  try {
    const raw = requireObject(readJsonFile(entityPath), "artifacts/entity-registry.json")
    return raw as unknown as EntityRegistryExportDocument
  } catch {
    return null
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
    actions: 0,
    valueSources: 0,
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
  const actions = docActions(meta)
  const valueSources = docValueSources(meta)
  if (!Array.isArray(meta.phases)) errors.push("sync-metadata.json: phases array is required")
  else counts.phases = meta.phases.length
  if (!Array.isArray(meta.actions) && !Array.isArray(meta.stepTypes)) {
    errors.push("sync-metadata.json: actions array is required")
  } else {
    counts.actions = actions.length
  }
  counts.valueSources = valueSources.length
  counts.flows = meta.flows && typeof meta.flows === "object" ? Object.keys(meta.flows).length : 0
  if (counts.flows === 0) errors.push("sync-metadata.json: flows object is required")

  for (const action of actions) {
    const idError = validateCatalogId(action.id, "Action id")
    if (idError) errors.push(`sync-metadata.json actions: ${idError}`)
  }
  for (const source of valueSources) {
    const idError = validateCatalogId(source.id, "Value source id")
    if (idError) errors.push(`sync-metadata.json valueSources: ${idError}`)
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
            tenantId: asTenantId(item.def.tenantId || DEFAULT_TENANT),
          })
          if (!validation.ok) {
            for (const issue of validation.errors) {
              errors.push(`entity "${item.def.id}": ${issue.message}`)
            }
          }
          validateFlowPreset(item.def.id, item.def.flowId)
        }
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
      connectorId: typeof raw.connectorId === "string" && raw.connectorId.trim() !== "" ? raw.connectorId.trim() : null,
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
      allowedSyncEnvironments: Array.isArray(raw.allowedSyncEnvironments)
        ? raw.allowedSyncEnvironments.map(String)
        : Array.isArray(raw.allowedSyncConnections)
          ? raw.allowedSyncConnections.map(String)
          : Array.isArray(raw.allowedSyncTargets)
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
  const actions = docActions(doc)
  const wiring = docValueSources(doc)
  const flows = doc.flows ?? {}
  const flowCatalog = buildFlowCatalogFromSyncMetadataDoc(doc)

  const phaseIds = new Set(phases.map((p) => p.id))
  const kindIds = new Set(actions.map((k) => k.id))
  const wiringIds = new Set(wiring.map((w) => w.id))
  const flowIds = new Set(Object.keys(flows))

  for (const phase of phases) {
    const existing = db.listSyncPhases(tenantId).find((row) => row.id === phase.id)
    db.saveSyncPhase({
      tenant_id: tenantId,
      id: phase.id,
      label: phase.label,
      sort_order: phase.sortOrder,
      built_in: existing?.built_in ?? 1,
      definition_json: JSON.stringify(phase.definition),
    })
  }
  for (const row of db.listSyncPhases(tenantId)) {
    if (!phaseIds.has(row.id) && row.built_in === 0) db.deleteSyncPhase(tenantId, row.id)
  }

  for (const action of actions) {
    const existing = db.listSyncActions(tenantId).find((row) => row.id === action.id)
    db.saveSyncAction({
      tenant_id: tenantId,
      id: action.id,
      label: action.label,
      built_in: existing?.built_in ?? 1,
      definition_json: JSON.stringify(action.definition),
    })
  }
  for (const row of db.listSyncActions(tenantId)) {
    if (!kindIds.has(row.id) && row.built_in === 0) db.deleteSyncAction(tenantId, row.id)
  }

  for (const source of wiring) {
    const existing = db.listSyncValueSources(tenantId).find((row) => row.id === source.id)
    db.saveSyncValueSource({
      tenant_id: tenantId,
      id: source.id,
      label: source.label,
      built_in: existing?.built_in ?? 1,
      definition_json: JSON.stringify(source.definition),
    })
  }
  for (const row of db.listSyncValueSources(tenantId)) {
    if (!wiringIds.has(row.id) && row.built_in === 0) db.deleteSyncValueSource(tenantId, row.id)
  }

  for (const [id, flow] of Object.entries(flows)) {
    const existing = db.getSyncFlow(tenantId, id)
    let stepsJson: string
    try {
      stepsJson = JSON.stringify(prepareFlowStepsForStorage(flow.steps ?? [], flowCatalog))
    } catch (error) {
      const message = error instanceof FlowStepsValidationError ? error.message : String(error)
      throw new Error(`sync-metadata.json flow "${id}": ${message}`)
    }
    db.saveSyncFlow({
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
  for (const row of db.listSyncFlows(tenantId)) {
    if (!flowIds.has(row.id) && row.built_in === 0) db.deleteSyncFlow(tenantId, row.id)
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

/**
 * Legacy zip compat: sync-definition-configs.json only patches entity.flowId.
 * Bindings/ownership in that file are ignored (compose-time stubs on Publish).
 */
function applyLegacyConfigFlowIds(
  tenantId: string,
  doc: SyncDefinitionConfigExportDocument | null,
  projectRoot: string,
  actor: string,
): number {
  if (!doc?.configs?.length) return 0
  const flowTemplateCatalog = loadAuthoringFlowCatalog(projectRoot, tenantId)
  let count = 0
  for (const config of doc.configs) {
    const entity = db.getEntityDefinition(tenantId, config.entityId)
    if (!entity) continue
    const flowId = hasSyncDefinitionFlowTemplate(flowTemplateCatalog, config.flowPreset)
      ? config.flowPreset
      : defaultSyncDefinitionFlowTemplateId(asEntityId(config.entityId), flowTemplateCatalog)
    if (entity.flowId === flowId) continue
    db.saveEntityDefinition({
      tenantId: asTenantId(tenantId),
      def: { ...entity, flowId: asFlowId(flowId) },
      actor,
      reason: "catalog-import:legacy-config-flowId",
    })
    count++
  }
  return count
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
        tenantId: asTenantId(tenantId),
        def: { ...item.def, tenantId: asTenantId(tenantId) },
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
  const projectRoot = args.projectRoot

  getDb().transaction(() => {
    applyEnvironments(args.snapshot.environments as EnvironmentsDoc)
    applySyncMetadata(tenantId, args.snapshot.syncMetadata as SyncMetadataDoc)
    applyStrategies(tenantId, args.snapshot.strategies as StrategiesDoc, args.actor)
    applyEntityDefinitions(tenantId, args.snapshot, args.actor)
    // Entities already carry flowId. Legacy configs JSON only patches flowId when present.
    if (args.snapshot.syncDefinitionConfigs?.configs?.length) {
      applyLegacyConfigFlowIds(
        tenantId,
        args.snapshot.syncDefinitionConfigs,
        projectRoot,
        args.actor,
      )
    }
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
