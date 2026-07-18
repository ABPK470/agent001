/**
 * Rebuild deploy/sync artifacts from legacy MyMI pipeline ground truth.
 *
 * Legacy ABI model (MyMI):
 *   core.Pipeline  → sync flow template per entity type
 *   core.Activity  → ordered step/action in that flow
 *
 * Mia model:
 *   entity registry entry  ← derived table scopes + predicates from uspSync*ObjectsTran
 *   sync-metadata.json     ← step types (actions) + flows (pipelines)
 *   flow-templates.json    ← view of sync-metadata.flows
 *   legacy-activity-sync-specs.json ← offline overlay keyed by pipelineId:sequence
 *
 * Used by:
 *   - generators/refresh-from-legacy.mjs (CLI)
 *   - POST /api/platform/artifacts/refresh (server)
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { loadCatalogIndexFromPool } from "./catalog-index.mjs"
import { buildLegacyActivitySyncSpecs } from "./legacy-activity-sync-specs.mjs"
import {
  buildCatalogIndex,
  deriveSyncDefinitions,
  extractSyncObjectCalls,
} from "./legacy-entity-derivation.mjs"
import {
  connectMssql,
  DEFAULT_PIPELINE_IDS,
  fetchPipelineEvidence,
  loadLegacyActivitySyncSpecs,
  parsePipelineIds,
  validatePipelineEvidence,
} from "./legacy-pipeline-evidence.mjs"
import {
  buildFlowTemplateCatalogFromSyncMetadata,
  buildSyncMetadataFromPipelines,
  validateSyncMetadataCoversFlows,
} from "./sync-metadata-derivation.mjs"

export const SOURCE_ARTIFACT = "deploy/sync/generators/refresh-from-legacy.mjs"

export const PATHS = {
  entitiesDir: "deploy/sync/artifacts/entities",
  syncMetadata: "deploy/sync/artifacts/sync-metadata.json",
  flowTemplates: "deploy/sync/artifacts/flow-templates.json",
  activitySpecs: "deploy/sync/fixtures/legacy-activity-sync-specs.json",
  evidenceFixture: "deploy/sync/fixtures/legacy-pipeline-evidence.fixture.json",
}

/**
 * @param {string} projectRoot
 * @param {{
 *   connection?: string | null
 *   evidenceFile?: string | null
 *   catalogFile?: string | null
 *   pipelineIds?: string | null
 *   specsFile?: string
 *   force?: boolean
 *   metadataOnly?: boolean
 * }} [options]
 */
export async function refreshDeployArtifactsFromLegacy(projectRoot, options = {}) {
  const pipelineIds = parsePipelineIds(options.pipelineIds ?? null)
  const force = options.force ?? true
  const metadataOnly = options.metadataOnly ?? false
  const specsFile = options.specsFile ?? PATHS.activitySpecs

  const evidence = await loadEvidence(projectRoot, options, pipelineIds)
  validatePipelineEvidence(pipelineIds, evidence, {
    requireSyncObjectCalls: !metadataOnly,
  })

  const selectedPipelines = evidence.pipelines.filter((pipeline) =>
    pipelineIds.includes(Number(pipeline.pipelineId)),
  )
  const generatedAt = new Date().toISOString()
  const entityIds = []
  /** @type {string | null} */
  let authoredStagingDir = null

  if (!metadataOnly) {
    const catalogIndex = await loadCatalogIndex(projectRoot, options)
    // Authored stays in temp only — materialize writes EntityDefinition into PATHS.entitiesDir.
    authoredStagingDir = mkdtempSync(join(tmpdir(), "mia-authored-staging-"))
    for (const definition of deriveSyncDefinitions(
      selectedPipelines,
      catalogIndex,
      generatedAt,
      SOURCE_ARTIFACT,
    )) {
      writeJson(join(authoredStagingDir, `${definition.id}.json`), definition, true)
      entityIds.push(definition.id)
    }
  }

  const activitySyncSpecs = loadActivitySyncSpecsOverlay(projectRoot, specsFile)
  const syncMetadata = buildSyncMetadataFromPipelines(selectedPipelines, { activitySyncSpecs })
  validateSyncMetadataCoversFlows(syncMetadata)

  writeJson(resolve(projectRoot, PATHS.syncMetadata), syncMetadata, force)

  const flowCatalog = buildFlowTemplateCatalogFromSyncMetadata(syncMetadata)
  writeJson(resolve(projectRoot, PATHS.flowTemplates), flowCatalog, force)

  const specsArtifact = buildLegacyActivitySyncSpecs(evidence, flowCatalog, syncMetadata)
  writeJson(resolve(projectRoot, PATHS.activitySpecs), specsArtifact, force)

  if (!metadataOnly && authoredStagingDir && entityIds.length > 0) {
    try {
      mkdirSync(resolve(projectRoot, PATHS.entitiesDir), { recursive: true })
      materializeNativeEntitySeeds(projectRoot, authoredStagingDir)
    } finally {
      rmSync(authoredStagingDir, { recursive: true, force: true })
    }
  }

  return {
    ok: true,
    connection: options.connection ?? process.env["MSSQL_DEFAULT_CONNECTION"] ?? "default",
    pipelineIds,
    entities: entityIds,
    stepTypes: syncMetadata.actions.length,
    actions: syncMetadata.actions.length,
    flows: Object.keys(syncMetadata.flows).length,
    activitySpecs: Object.keys(specsArtifact.specs ?? {}).length,
    paths: { ...PATHS },
  }
}

/**
 * Authored (staging dir) → EntityDefinition + embedded `run`
 * (1:1 via entityDefinitionFromAuthoredSync).
 * @param {string} projectRoot
 * @param {string} authoredDir
 */
function materializeNativeEntitySeeds(projectRoot, authoredDir) {
  const script = resolve(projectRoot, "packages/sync/scripts/materialize-native-entity-seeds.ts")
  const result = spawnSync(
    "npx",
    ["tsx", script, projectRoot, `--authored-dir=${authoredDir}`],
    {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  if (result.status !== 0) {
    throw new Error(
      `materialize-native-entity-seeds failed: ${result.stderr || result.stdout || `exit ${result.status}`}`,
    )
  }
}

async function loadEvidence(projectRoot, options, pipelineIds) {
  if (options.evidenceFile) {
    return JSON.parse(readFileSync(resolve(projectRoot, options.evidenceFile), "utf-8"))
  }

  const pool = await connectMssql(options.connection ?? null)
  try {
    return await fetchPipelineEvidence(pool, {
      pipelineIds: pipelineIds.join(","),
      extractSyncObjectCalls,
    })
  } finally {
    await pool.close()
  }
}

async function loadCatalogIndex(projectRoot, options) {
  if (options.catalogFile) {
    const snapshot = JSON.parse(readFileSync(resolve(projectRoot, options.catalogFile), "utf-8"))
    return buildCatalogIndex(snapshot)
  }

  const pool = await connectMssql(options.connection ?? null)
  try {
    return await loadCatalogIndexFromPool(pool)
  } finally {
    await pool.close()
  }
}

function loadActivitySyncSpecsOverlay(projectRoot, specsFile) {
  const projectPath = resolve(projectRoot, specsFile)
  if (existsSync(projectPath)) return loadLegacyActivitySyncSpecs(projectPath)
  return loadLegacyActivitySyncSpecs()
}

function writeJson(path, doc, force) {
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path) && !force) {
    throw new Error(`Refusing to overwrite without --force: ${path}`)
  }
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf-8")
}
