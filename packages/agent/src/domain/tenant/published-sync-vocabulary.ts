/**
 * Published sync entity IDs — runtime vocabulary from definitions.bundle.json.
 *
 * Not tenant config: entity types (pipelineActivity, contract, …) are
 * authoritative in the published bundle and loaded once at server boot.
 */

import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"

const vocabularyState = {
  entityIds: [] as readonly string[]
}

/** Entity type ids from the published sync bundle (e.g. pipelineActivity). */
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

/**
 * Read `definitions` keys from the published bundle. Missing file → empty list.
 * Invalid JSON throws so a broken bundle fails at boot.
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
