/**
 * Published sync entity IDs — runtime vocabulary from live SyncDefinitions (SQLite).
 *
 * Not tenant config: entity types (pipelineActivity, contract, …) are
 * authoritative in published sync_definitions and loaded once at server boot.
 */

import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"

const vocabularyState = {
  entityIds: [] as readonly string[]
}

/** Entity type ids from published SyncDefinitions (e.g. pipelineActivity). */
export function getPublishedSyncEntityIds(): readonly string[] {
  return vocabularyState.entityIds
}

export function setPublishedSyncEntityIds(ids: readonly string[]): readonly string[] {
  vocabularyState.entityIds = Object.freeze([...ids])
  return vocabularyState.entityIds
}

export function resetPublishedSyncEntityIds(): void {
  vocabularyState.entityIds = []
}

/** Load vocabulary from an ordered list of entity ids (SQLite publish path). */
export function loadPublishedSyncEntityIdsFromList(ids: readonly string[]): readonly string[] {
  return setPublishedSyncEntityIds([...ids].sort())
}

/**
 * @deprecated Prefer loadPublishedSyncEntityIdsFromList after reading SQLite.
 * Still used by tests that fixture a legacy file bundle.
 */
export function loadPublishedSyncEntityIdsFromBundle(
  bundlePath: string,
  options: { baseDir?: string } = {}
): readonly string[] {
  const resolved = isAbsolute(bundlePath) ? bundlePath : resolve(options.baseDir ?? process.cwd(), bundlePath)
  if (!existsSync(resolved)) {
    return setPublishedSyncEntityIds([])
  }
  const raw = readFileSync(resolved, "utf8")
  const parsed = JSON.parse(raw) as { definitions?: Record<string, unknown> }
  const ids = Object.keys(parsed.definitions ?? {}).sort()
  return setPublishedSyncEntityIds(ids)
}
