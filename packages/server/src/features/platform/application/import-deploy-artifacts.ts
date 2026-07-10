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
import { withPermissionDefaults } from "@mia/sync"

import * as db from "../../../platform/persistence/sqlite.js"
import { getDb } from "../../../platform/persistence/sqlite.js"
import { applyEntityRunYaml } from "../../sync/application/apply-entity-run-yaml.js"
import {
  buildEntityRegistryExportDocument,
  parseEntitiesJson,
  type EntityRegistryExportDocument,
} from "../../sync/domain/entity-yaml.js"
import type { DeployCatalogSnapshot } from "./export-deploy-artifacts.js"

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
        if (!item.ok) errors.push(`entity ${item.error}`)
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
      defaultAccessMode: (raw.defaultAccessMode as SyncEnvironment["defaultAccessMode"]) ?? "read_write",
      allowedOperations: (raw.allowedOperations as SyncEnvironment["allowedOperations"]) ?? undefined,
      denyDml: Boolean(raw.denyDml),
      denyDdl: Boolean(raw.denyDdl),
      approvalRequiredOperations:
        (raw.approvalRequiredOperations as SyncEnvironment["approvalRequiredOperations"]) ?? [],
      syncAllowlist: Array.isArray(raw.syncAllowlist) ? raw.syncAllowlist.map(String) : [],
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
    db.saveSyncRunPreset({
      tenant_id: tenantId,
      id,
      label: flow.label,
      description: flow.description ?? "",
      steps_json: JSON.stringify(flow.steps ?? []),
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

function applyEntities(
  tenantId: string,
  doc: EntityRegistryExportDocument | null,
  actor: string,
  projectRoot?: string,
): number {
  if (!doc?.entities?.length) return 0
  let count = 0
  for (const entry of doc.entities) {
    const parsed = parseEntitiesJson(JSON.stringify(entry))
    for (const item of parsed) {
      if (!item.ok || !item.def) throw new Error(item.error ?? "entity parse failed")
      const result = db.saveEntityDefinition({
        tenantId,
        def: { ...item.def, tenantId },
        actor,
        reason: "catalog-import",
      })
      if (item.run && projectRoot) {
        applyEntityRunYaml(projectRoot, tenantId, result.id, item.run, actor)
      }
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

  const tenantId = args.snapshot.tenantId || DEFAULT_TENANT

  getDb().transaction(() => {
    applyEnvironments(args.snapshot.environments as EnvironmentsDoc)
    applySyncMetadata(tenantId, args.snapshot.syncMetadata as SyncMetadataDoc)
    applyStrategies(tenantId, args.snapshot.strategies as StrategiesDoc, args.actor)
    applyEntities(tenantId, args.snapshot.entityRegistry, args.actor, args.projectRoot)
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
