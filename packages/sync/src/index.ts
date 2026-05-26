/**
 * Sync subsystem — public API.
 *
 * Outside this folder, import from `@mia/sync` or `./index.js` only.
 * Files inside this package (including `diff-engine/` and `orchestrator/`)
 * are private implementation details.
 */

export * from "./catalog-drift.js"
export * from "./diff-engine/index.js"
export * from "./entity-registry/index.js"
export * from "./environments.js"
export * from "./governance/freeze-windows.js"
export * from "./orchestrator/index.js"
export * from "./plan-store.js"
export * from "./proposer/index.js"
export * from "./recipes.js"
export * from "./sync-events.js"
export * from "./sync-run-sink.js"
export * from "./tools.js"

