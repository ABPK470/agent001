import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"

import type { PublishedSyncDefinitionBundle } from "./published-definitions.js"

interface PublishedDefinitionCacheState {
  bundle: PublishedSyncDefinitionBundle | null
  loadedFromPath: string | null
  loadedFromMtimeMs: number | null
  loadedFromSize: number | null
}

export interface PublishedSyncDefinitionRegistry {
  loadBundle(projectRoot: string, relPath: string): PublishedSyncDefinitionBundle
  clear(): void
}

export function createPublishedSyncDefinitionRegistry(): PublishedSyncDefinitionRegistry {
  const cache: PublishedDefinitionCacheState = {
    bundle: null,
    loadedFromPath: null,
    loadedFromMtimeMs: null,
    loadedFromSize: null
  }

  return {
    loadBundle(projectRoot, relPath) {
      const fullPath = resolve(projectRoot, relPath)
      if (!existsSync(fullPath)) {
        throw new Error(
          `Published sync definition bundle not found at ${relPath}. ` +
            `Run npm run sync:definitions:compile -- --write before previewing syncs.`
        )
      }

      const stats = statSync(fullPath)
      if (
        cache.bundle &&
        cache.loadedFromPath === fullPath &&
        cache.loadedFromMtimeMs === stats.mtimeMs &&
        cache.loadedFromSize === stats.size
      ) {
        return cache.bundle
      }

      const parsed = JSON.parse(readFileSync(fullPath, "utf-8")) as PublishedSyncDefinitionBundle
      if (parsed.version !== 1) {
        throw new Error(`Unsupported published sync definition bundle version: ${parsed.version}`)
      }

      cache.bundle = parsed
      cache.loadedFromPath = fullPath
      cache.loadedFromMtimeMs = stats.mtimeMs
      cache.loadedFromSize = stats.size
      return parsed
    },
    clear() {
      cache.bundle = null
      cache.loadedFromPath = null
      cache.loadedFromMtimeMs = null
      cache.loadedFromSize = null
    }
  }
}
