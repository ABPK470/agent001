/**
 * Published SyncDefinition registry backed by an injected loader (SQLite in production).
 * Always reads through the loader — no stale cache after Publish.
 */

import type { PublishedSyncDefinitionRegistry } from "../ports/published-definition-registry.js"
import type { PublishedSyncDefinitionBundle } from "@mia/shared-types"

export function createDbPublishedSyncDefinitionRegistry(
  load: () => PublishedSyncDefinitionBundle | null,
): PublishedSyncDefinitionRegistry {
  return {
    loadBundle(_projectRoot, _relPath) {
      const bundle = load()
      if (!bundle) {
        throw new Error(
          "No published sync definitions in the database. " +
            "Publish from Entity Registry (⚙ → Publish) before preview/execute.",
        )
      }
      if (bundle.version !== 1) {
        throw new Error(`Unsupported published sync definition bundle version: ${bundle.version}`)
      }
      return bundle
    },
    clear() {
      /* no cache */
    },
  }
}
