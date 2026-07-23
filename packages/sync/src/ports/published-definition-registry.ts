import type { PublishedSyncDefinitionBundle } from "@mia/shared-types"

/**
 * Host-owned registry for loading the published sync definition bundle.
 * Implementations: `runtime/published-definition-registry.ts` (disk),
 * `runtime/db-published-definition-registry.ts` (DB).
 */
export interface PublishedSyncDefinitionRegistry {
  loadBundle(projectRoot: string, relPath: string): PublishedSyncDefinitionBundle
  clear(): void
}
