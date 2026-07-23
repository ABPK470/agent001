/**
 * Sync domain barrel — vocabulary only (types, enums, shapes).
 * Pure decisions: `@mia/sync` core exports / `core/`.
 * Host façades: `runtime/`.
 */

export * from "./plan.js"
export * from "./definition-selection.js"
export * from "./diff-engine/index.js"
export * from "./entity-registry/index.js"
export * from "./enums.js"
export * from "./environments.js"
export * from "./governance/freeze-windows.js"
export * from "./publish-readiness.js"
export * from "./types/branded-ids.js"

/** @deprecated Use SyncEntityId */
export type { SyncEntityId as EntityType } from "./definition-selection.js"
