/**
 * Sync domain barrel.
 */

export * from "./catalog-drift.js"
export * from "./compile-sync-definition.js"
export * from "./definition-selection.js"
export * from "./entity-instance-ref.js"
export * from "./diff-engine/index.js"
export * from "./entity-registry/index.js"
export * from "./enums.js"
export * from "./environments.js"
export * from "./governance/env-operations.js"
export * from "./governance/freeze-windows.js"
export * from "./predicate.js"
export * from "./published-definition-registry.js"
export * from "./operational-vocabulary.js"
export * from "./sync-operation-intent.js"
export * from "./sync-drift-intent.js"
export * from "./sync-scope-resolution.js"
export * from "./published-definitions.js"
export * from "./sync-definition-flow-templates.js"
export * from "./sync-definition-scaffold.js"
export * from "./load-sync-metadata-artifact.js"
export * from "./load-strategies-artifact.js"
export * from "./catalog-definition-parse.js"
export * from "./flow-catalog.js"
export * from "./normalize-flow-step.js"
export * from "./resolve-flow-steps.js"
export * from "./validate-sync-flow.js"

/** @deprecated Use SyncEntityId */
export type { SyncEntityId as EntityType } from "./definition-selection.js"
