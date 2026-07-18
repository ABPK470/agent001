/**
 * Import deploy/sync git layout (format A) into SQLite without factory reset.
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

import type { AuthoredSyncDefinition } from "@mia/shared-types"

import { getDb } from "../../../infra/persistence/sqlite.js"
import { importOneAuthoredSync } from "../../sync/service/import-authored-sync.js"
import { loadAuthoringFlowCatalog } from "../../sync/service/definitions.js"
import { parseAuthoredSyncJson } from "../../sync/types/authored-sync-document.js"
import type { CatalogImportPreview, CatalogImportResult, CatalogImportSectionCounts } from "./import-deploy-artifacts.js"
import { applyDeployGitPlatformFiles } from "./import-deploy-artifacts.js"

const DEFAULT_TENANT = "_default"

export interface DeployGitImportBundle {
  exportedAt: string
  tenantId: string
  entityIds: string[]
  entities: AuthoredSyncDefinition[]
  syncMetadata: Record<string, unknown>
  strategies: Record<string, unknown>
  environments: Record<string, unknown>
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

function resolveBundleRoot(extractedDir: string): string {
  const directManifest = join(extractedDir, "manifest.json")
  if (existsSync(directManifest)) return extractedDir
  for (const entry of readdirSync(extractedDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(extractedDir, entry.name)
    if (existsSync(join(candidate, "manifest.json"))) return candidate
  }
  throw new Error("manifest.json not found in deploy artifact import bundle")
}

export function parseDeployGitBundleFromDir(bundleDir: string): DeployGitImportBundle {
  const root = resolve(bundleDir)
  const manifest = requireObject(readJsonFile(join(root, "manifest.json")), "manifest.json")
  const entitiesDir = join(root, "artifacts", "entities")
  if (!existsSync(entitiesDir)) {
    throw new Error("artifacts/entities directory is required in deploy artifact bundle")
  }

  const entities: AuthoredSyncDefinition[] = []
  const entityIds: string[] = []
  for (const name of readdirSync(entitiesDir).filter((file) => file.endsWith(".json")).sort()) {
    const text = readFileSync(join(entitiesDir, name), "utf-8")
    const parsed = parseAuthoredSyncJson(text)
    if (!parsed[0]?.ok || !parsed[0].authored) {
      throw new Error(`${name}: ${parsed[0]?.error ?? "invalid artifact"}`)
    }
    entities.push(parsed[0].authored)
    entityIds.push(parsed[0].authored.id)
  }

  return {
    exportedAt: typeof manifest.exportedAt === "string" ? manifest.exportedAt : new Date().toISOString(),
    tenantId: typeof manifest.tenantId === "string" ? manifest.tenantId : DEFAULT_TENANT,
    entityIds:
      Array.isArray(manifest.entityIds) && manifest.entityIds.length > 0
        ? (manifest.entityIds as string[])
        : entityIds,
    entities,
    syncMetadata: requireObject(
      readJsonFile(join(root, "artifacts", "sync-metadata.json")),
      "artifacts/sync-metadata.json",
    ),
    strategies: requireObject(
      readJsonFile(join(root, "artifacts", "strategies.json")),
      "artifacts/strategies.json",
    ),
    environments: requireObject(readJsonFile(join(root, "sync-environments.json")), "sync-environments.json"),
  }
}

export function parseDeployGitZipBuffer(buffer: Buffer): DeployGitImportBundle {
  const parent = mkdtempSync(join(tmpdir(), "mia-deploy-import-"))
  const zipPath = join(parent, "bundle.zip")
  writeFileSync(zipPath, buffer)
  const unzip = spawnSync("unzip", ["-q", zipPath], { cwd: parent, encoding: "utf-8" })
  if (unzip.status !== 0) {
    rmSync(parent, { recursive: true, force: true })
    throw new Error("Zip import is unavailable on this host (install the `unzip` CLI).")
  }
  try {
    return parseDeployGitBundleFromDir(resolveBundleRoot(parent))
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

export function validateDeployGitBundle(bundle: DeployGitImportBundle): CatalogImportPreview {
  const errors: string[] = []
  const counts: CatalogImportSectionCounts = {
    environments: 0,
    phases: 0,
    actions: 0,
    valueSources: 0,
    flows: 0,
    strategies: 0,
    entities: bundle.entities.length,
  }

  if (bundle.entities.length === 0) {
    errors.push("artifacts/entities: at least one entity artifact is required")
  }

  const meta = bundle.syncMetadata as {
    phases?: unknown[]
    actions?: unknown[]
    valueSources?: unknown[]
    stepTypes?: unknown[]
    customValueSources?: unknown[]
    flows?: Record<string, unknown>
  }
  const actions = Array.isArray(meta.actions)
    ? meta.actions
    : Array.isArray(meta.stepTypes)
      ? meta.stepTypes
      : null
  const valueSources = Array.isArray(meta.valueSources)
    ? meta.valueSources
    : Array.isArray(meta.customValueSources)
      ? meta.customValueSources
      : []
  if (!Array.isArray(meta.phases)) errors.push("sync-metadata.json: phases array is required")
  else counts.phases = meta.phases.length
  if (!actions) errors.push("sync-metadata.json: actions array is required")
  else counts.actions = actions.length
  counts.valueSources = valueSources.length
  counts.flows = meta.flows && typeof meta.flows === "object" ? Object.keys(meta.flows).length : 0
  if (counts.flows === 0) errors.push("sync-metadata.json: flows object is required")

  const strategiesDoc = bundle.strategies as { strategies?: unknown[] }
  if (!Array.isArray(strategiesDoc.strategies)) {
    errors.push("strategies.json: strategies array is required")
  } else {
    counts.strategies = strategiesDoc.strategies.length
  }

  const envDoc = bundle.environments as { environments?: unknown[] }
  if (!Array.isArray(envDoc.environments)) {
    errors.push("sync-environments.json: environments array is required")
  } else {
    counts.environments = envDoc.environments.length
  }

  return { ok: errors.length === 0, errors, counts }
}

export function applyDeployGitBundle(args: {
  bundle: DeployGitImportBundle
  actor: string
  projectRoot: string
  dryRun?: boolean
}): CatalogImportResult {
  const preview = validateDeployGitBundle(args.bundle)
  if (!preview.ok || args.dryRun) {
    return { ...preview, dryRun: true, applied: false }
  }

  const tenantId = args.bundle.tenantId || DEFAULT_TENANT
  const flowTemplateCatalog = loadAuthoringFlowCatalog(args.projectRoot, tenantId)

  getDb().transaction(() => {
    applyDeployGitPlatformFiles({
      tenantId,
      actor: args.actor,
      syncMetadata: args.bundle.syncMetadata,
      strategies: args.bundle.strategies,
      environments: args.bundle.environments,
    })

    for (const authored of args.bundle.entities) {
      const result = importOneAuthoredSync({
        authored,
        tenantId,
        actor: args.actor,
        reason: "deploy-artifact-import",
        projectRoot: args.projectRoot,
        dryRun: false,
        flowTemplateCatalog,
      })
      if (result.error) {
        throw new Error(
          typeof result.error === "string"
            ? result.error
            : `entity "${result.id}": validation failed`,
        )
      }
    }
  })()

  return { ...preview, dryRun: false, applied: true }
}
