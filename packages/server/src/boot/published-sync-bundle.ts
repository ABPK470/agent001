/**
 * Published SyncDefinitions — boot load, publish reload, and setup messaging.
 *
 * Live definitions live in SQLite (`sync_definitions`). Publish never writes a
 * file into the working tree. A legacy file bundle may be imported once into DB
 * when meta is empty (upgrade path).
 */

import {
  loadPublishedSyncEntityIdsFromList,
  setPublishedSyncEntityIds,
} from "@mia/agent"
import type { PublishedSyncDefinition, PublishedSyncDefinitionBundle } from "@mia/shared-types"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import * as db from "../infra/persistence/sqlite.js"

/** @deprecated Not written by Publish; only used for one-time upgrade import. */
export const PUBLISHED_SYNC_BUNDLE_PATH = "sync-definitions/published/definitions.bundle.json"

export function publishedSyncBundlePath(projectRoot: string): string {
  return resolve(projectRoot, PUBLISHED_SYNC_BUNDLE_PATH)
}

export function isPublishedSyncBundlePresent(_projectRoot: string): boolean {
  try {
    return db.getSyncPublishMeta() != null && db.listSyncDefinitions().length > 0
  } catch {
    // Setup checks may run before migrations (or against an empty data dir).
    return false
  }
}

/**
 * If SQLite has no publish meta but a legacy file bundle exists, import it once.
 */
export function importLegacyPublishedBundleFileIfNeeded(projectRoot: string): boolean {
  if (db.getSyncPublishMeta() != null) return false
  const path = publishedSyncBundlePath(projectRoot)
  if (!existsSync(path)) return false
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
    version?: number
    publishedAt?: string
    publishedVersion?: string
    catalogVersion?: number | null
    definitions?: Record<string, PublishedSyncDefinition | null>
  }
  if (parsed.version !== 1 || !parsed.definitions) {
    throw new Error(`Invalid legacy published bundle at ${PUBLISHED_SYNC_BUNDLE_PATH}`)
  }
  const publishedAt = parsed.publishedAt ?? new Date().toISOString()
  const publishedVersion = parsed.publishedVersion ?? publishedAt
  db.replaceSyncDefinitions("_default", {
    publishedAt,
    publishedVersion,
    catalogVersion: parsed.catalogVersion ?? null,
    definitions: parsed.definitions,
  })
  console.log(
    `Imported legacy published bundle into SQLite (${Object.keys(parsed.definitions).length} definitions)`,
  )
  return true
}

function vocabularyIdsFromDb(): readonly string[] {
  return db.listSyncDefinitions().map((row) => row.entity_id)
}

/** Load entity ids into the agent singleton; log success or a boot warning. */
export function loadPublishedSyncVocabularyAtBoot(projectRoot: string): readonly string[] {
  importLegacyPublishedBundleFileIfNeeded(projectRoot)
  const syncIds = loadPublishedSyncEntityIdsFromList(vocabularyIdsFromDb())
  if (syncIds.length > 0) {
    console.log(`Published sync vocabulary: ${syncIds.length} entity types (${syncIds.join(", ")})`)
  } else {
    console.warn(formatPublishedSyncBundleMissingWarning())
  }
  return syncIds
}

/** Reload in-process vocabulary after publish (no server restart). */
export function reloadPublishedSyncVocabulary(_projectRoot?: string): readonly string[] {
  return loadPublishedSyncEntityIdsFromList(vocabularyIdsFromDb())
}

export function loadPublishedBundleFromSqlite(): PublishedSyncDefinitionBundle | null {
  const raw = db.loadPublishedBundleFromDb()
  if (!raw) return null
  return {
    version: 1,
    publishedAt: raw.publishedAt,
    publishedVersion: raw.publishedVersion,
    catalogVersion: raw.catalogVersion,
    definitions: raw.definitions as PublishedSyncDefinitionBundle["definitions"],
  }
}

export function formatPublishedSyncBundleMissingWarning(): string {
  return [
    "Published sync definitions: none in SQLite — sync preview/execute disabled until you publish.",
    "  After first start: Entity Registry → ⚙ → Publish",
  ].join("\n")
}

export function formatSyncBootNote(): string {
  return [
    "Sync onboarding (after first server start):",
    "  1. Entity Registry → review entities (boot-seeded from deploy/sync/artifacts)",
    "  2. Entity Registry → ⚙ → Publish  (required — writes SyncDefinitions to SQLite)",
    "  3. Policies → Platform → Rebuild schema catalog  (when MSSQL is configured)",
    "  Publish reloads agent vocabulary immediately — no restart needed.",
  ].join("\n")
}

/** Clear vocabulary (tests). */
export function clearPublishedSyncVocabulary(): void {
  setPublishedSyncEntityIds([])
}
