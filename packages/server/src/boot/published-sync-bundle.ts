/**
 * Published sync bundle — boot load, publish reload, and setup messaging.
 *
 * The bundle is written only by Entity Registry publish, not by `npm run setup`
 * or first boot. Goal routing and sync preview/execute read it when present.
 */

import { loadPublishedSyncEntityIdsFromBundle } from "@mia/agent"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

export const PUBLISHED_SYNC_BUNDLE_PATH = "sync-definitions/published/definitions.bundle.json"

export function publishedSyncBundlePath(projectRoot: string): string {
  return resolve(projectRoot, PUBLISHED_SYNC_BUNDLE_PATH)
}

export function isPublishedSyncBundlePresent(projectRoot: string): boolean {
  return existsSync(publishedSyncBundlePath(projectRoot))
}

/** Load entity ids into the agent singleton; log success or a boot warning. */
export function loadPublishedSyncVocabularyAtBoot(projectRoot: string): readonly string[] {
  const syncIds = loadPublishedSyncEntityIdsFromBundle(PUBLISHED_SYNC_BUNDLE_PATH, {
    baseDir: projectRoot
  })
  if (syncIds.length > 0) {
    console.log(`Published sync vocabulary: ${syncIds.length} entity types (${syncIds.join(", ")})`)
  } else {
    console.warn(formatPublishedSyncBundleMissingWarning())
  }
  return syncIds
}

/** Reload in-process vocabulary after publish (no server restart). */
export function reloadPublishedSyncVocabulary(projectRoot: string): readonly string[] {
  return loadPublishedSyncEntityIdsFromBundle(PUBLISHED_SYNC_BUNDLE_PATH, { baseDir: projectRoot })
}

export function formatPublishedSyncBundleMissingWarning(): string {
  return [
    "Published sync bundle: not found — sync preview/execute disabled until you publish.",
    "  After first start: Entity Registry → ⚙ → Publish",
    `  Writes ${PUBLISHED_SYNC_BUNDLE_PATH}`
  ].join("\n")
}

export function formatSyncBootNote(): string {
  return [
    "Sync onboarding (after first server start):",
    "  1. Entity Registry → review entities (boot-seeded from deploy/sync/artifacts)",
    "  2. Entity Registry → ⚙ → Publish  (required — writes definitions.bundle.json)",
    "  3. Policies → Platform → Rebuild schema catalog  (when MSSQL is configured)",
    "  Publish reloads agent vocabulary immediately — no restart needed."
  ].join("\n")
}
