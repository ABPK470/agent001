import type { PublishedSyncDefinitionBundle } from "./published-definitions.js"

/**
 * Host-owned registry for loading the published sync definition bundle.
 * Implementation (disk + cache) lives in `runtime/published-definition-registry.ts`.
 */
export interface PublishedSyncDefinitionRegistry {
  loadBundle(projectRoot: string, relPath: string): PublishedSyncDefinitionBundle
  clear(): void
}
