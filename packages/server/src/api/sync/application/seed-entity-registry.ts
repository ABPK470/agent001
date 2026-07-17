/**
 * Bootstrap entity_defs on a fresh database from deploy-owned artifacts.
 *
 * Authority model:
 *   - SQLite entity_defs is the live authoring source of truth.
 *   - deploy/sync/entity-registry.seed.yaml (when present) is the preferred
 *     cold-start snapshot of EntityDefinition documents.
 *   - Otherwise deploy/sync/artifacts/entities/*.json (authored sync defs)
 *     are imported via entityDefinitionFromAuthoredSync.
 *
 * Idempotent: no-op when the tenant already has entity rows.
 */

import type { AuthoredSyncDefinition } from "@mia/shared-types"
import {
  entityDefinitionFromAuthoredSync,
  loadEntityDefinitionsFromDocument,
  projectTablePredicate,
  validateEntityDefinition,
  type EntityDefinition,
} from "@mia/sync"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import * as db from "../../../platform/persistence/sqlite.js"

const DEFAULT_TENANT_ID = "_default"
const SEED_YAML = "deploy/sync/entity-registry.seed.yaml"
const ARTIFACTS_DIR = "deploy/sync/artifacts/entities"
const SEED_ACTOR = "system"
const SEED_REASON = "bundled-seed"

export type EntityRegistrySeedSource = "none" | "yaml" | "artifacts"

export interface EntityRegistrySeedResult {
  seeded: number
  source: EntityRegistrySeedSource
  entityIds: string[]
}

export function seedEntityRegistryIfEmpty(
  projectRoot: string,
  tenantId = DEFAULT_TENANT_ID,
): EntityRegistrySeedResult {
  const existing = db.listEntityDefinitions(tenantId)
  if (existing.length > 0) {
    return { seeded: 0, source: "none", entityIds: [] }
  }

  const yamlPath = resolve(projectRoot, SEED_YAML)
  if (existsSync(yamlPath)) {
    return seedFromYaml(yamlPath, tenantId)
  }

  return seedFromArtifacts(resolve(projectRoot, ARTIFACTS_DIR), tenantId)
}

/** Re-import shipped deploy artifacts when SQLite entity rows have drifted to degraded predicates. */
export function repairBundledEntityDefinitionsFromArtifacts(
  projectRoot: string,
  tenantId = DEFAULT_TENANT_ID,
): string[] {
  const artifactsDir = resolve(projectRoot, ARTIFACTS_DIR)
  if (!existsSync(artifactsDir)) return []

  const repaired: string[] = []
  for (const file of readdirSync(artifactsDir)
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    const path = resolve(artifactsDir, file)
    const authored = JSON.parse(readFileSync(path, "utf-8")) as AuthoredSyncDefinition
    const canonical = entityDefinitionFromAuthoredSync(authored, tenantId)
    const canonicalValidation = validateEntityDefinition(canonical)
    if (!canonicalValidation.ok) {
      throw new Error(
        `[entity-registry] deploy artifact ${file} failed validation: ${canonicalValidation.errors[0]?.message ?? "unknown"}`,
      )
    }

    const existing = db.getEntityDefinition(tenantId, authored.id)
    if (!existing || !validateEntityDefinition(existing).ok || entityDefinitionDrifted(existing, canonical)) {
      db.saveEntityDefinition({
        tenantId,
        def: canonical,
        actor: SEED_ACTOR,
        reason: "repair:deploy-artifact",
      })
      repaired.push(authored.id)
    }
  }
  return repaired
}

function entityDefinitionDrifted(existing: EntityDefinition, canonical: EntityDefinition): boolean {
  const canonicalPredicates = new Map(
    canonical.tables.map((table) => [
      table.name.toLowerCase(),
      projectTablePredicate(canonical, table),
    ]),
  )
  for (const table of existing.tables) {
    const expected = canonicalPredicates.get(table.name.toLowerCase())
    if (!expected) continue
    if (projectTablePredicate(existing, table) !== expected) return true
  }
  return false
}

function seedFromYaml(yamlPath: string, tenantId: string): EntityRegistrySeedResult {
  const definitions = loadEntityDefinitionsFromDocument(yamlPath)
  const entityIds: string[] = []
  for (const raw of definitions) {
    const def = { ...raw, tenantId }
    const validation = validateEntityDefinition(def)
    if (!validation.ok) {
      throw new Error(
        `[entity-registry] bundled YAML entity "${def.id}" failed validation: ${validation.errors[0]?.message ?? "unknown"}`,
      )
    }
    db.saveEntityDefinition({ tenantId, def, actor: SEED_ACTOR, reason: SEED_REASON })
    entityIds.push(def.id)
  }
  return { seeded: entityIds.length, source: "yaml", entityIds }
}

function seedFromArtifacts(artifactsDir: string, tenantId: string): EntityRegistrySeedResult {
  if (!existsSync(artifactsDir)) {
    return { seeded: 0, source: "none", entityIds: [] }
  }

  const entityIds: string[] = []
  const files = readdirSync(artifactsDir)
    .filter((name) => name.endsWith(".json"))
    .sort()

  for (const file of files) {
    const path = resolve(artifactsDir, file)
    const authored = JSON.parse(readFileSync(path, "utf-8")) as AuthoredSyncDefinition
    const def = entityDefinitionFromAuthoredSync(authored, tenantId)
    const validation = validateEntityDefinition(def)
    if (!validation.ok) {
      throw new Error(
        `[entity-registry] artifact ${file} failed validation: ${validation.errors[0]?.message ?? "unknown"}`,
      )
    }
    db.saveEntityDefinition({ tenantId, def, actor: SEED_ACTOR, reason: SEED_REASON })
    entityIds.push(def.id)
  }

  return { seeded: entityIds.length, source: "artifacts", entityIds }
}
