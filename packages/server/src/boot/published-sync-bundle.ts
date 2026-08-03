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
let publishedBundleCache: PublishedSyncDefinitionBundle | null = null

export function publishedSyncBundlePath(projectRoot: string): string {
  return resolve(projectRoot, PUBLISHED_SYNC_BUNDLE_PATH)
}

export async function isPublishedSyncBundlePresent(_projectRoot: string): Promise<boolean> {
  try {
    return await db.getSyncPublishMeta() != null && (await db.listSyncDefinitions()).length > 0
  } catch {
    // Setup checks may run before migrations (or against an empty data dir).
    return false
  }
}

/**
 * If SQLite has no publish meta but a legacy file bundle exists, import it once.
 */
export async function importLegacyPublishedBundleFileIfNeeded(projectRoot: string): Promise<boolean> {
  if (await db.getSyncPublishMeta() != null) return false
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
  await db.replaceSyncDefinitions("_default", {
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

async function vocabularyIdsFromDb(): Promise<readonly string[]> {
  return (await db.listSyncDefinitions()).map((row) => row.entity_id)
}

/** Load entity ids into the agent singleton; log success or a boot warning. */
export async function loadPublishedSyncVocabularyAtBoot(projectRoot: string): Promise<readonly string[]> {
  await importLegacyPublishedBundleFileIfNeeded(projectRoot)
  await refreshPublishedBundleCache()
  const syncIds = loadPublishedSyncEntityIdsFromList(await vocabularyIdsFromDb())
  if (syncIds.length > 0) {
    console.log(`Published sync vocabulary: ${syncIds.length} entity types (${syncIds.join(", ")})`)
  } else {
    console.warn(formatPublishedSyncBundleMissingWarning())
  }
  return syncIds
}

/** Reload in-process vocabulary after publish (no server restart). */
export async function reloadPublishedSyncVocabulary(_projectRoot?: string): Promise<readonly string[]> {
  await refreshPublishedBundleCache()
  return loadPublishedSyncEntityIdsFromList(await vocabularyIdsFromDb())
}

export async function loadPublishedBundleFromSqlite(): Promise<PublishedSyncDefinitionBundle | null> {
  const raw = await db.loadPublishedBundleFromDb()
  if (!raw) return null
  return {
    version: 1,
    publishedAt: raw.publishedAt,
    publishedVersion: raw.publishedVersion,
    catalogVersion: raw.catalogVersion,
    definitions: raw.definitions as PublishedSyncDefinitionBundle["definitions"],
  }
}

export async function refreshPublishedBundleCache(): Promise<PublishedSyncDefinitionBundle | null> {
  publishedBundleCache = await loadPublishedBundleFromSqlite()
  return publishedBundleCache
}

export function loadPublishedBundleFromSqliteCached(): PublishedSyncDefinitionBundle | null {
  return publishedBundleCache
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
