/**
 * Sync domain barrel.
 *
 * Pure sync concepts live here: environment metadata, recipe metadata,
 * catalog drift rules, freeze-window semantics, entity-registry projection,
 * and the diff engine.
 */

export * from "./catalog-drift.js"
export * from "./diff-engine/index.js"
export * from "./entity-registry/index.js"
export * from "./enums.js"
export * from "./environments.js"
export * from "./governance/freeze-windows.js"
export * from "./published-definitions.js"
export * from "./recipes.js"

