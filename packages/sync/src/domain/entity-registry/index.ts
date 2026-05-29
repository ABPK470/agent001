/**
 * Entity registry — public surface.
 *
 * Phase 0 (config uplift) entry point. Types + pure functions live here.
 * The persistence layer (versioned storage, multi-tenant scoping) lives in
 * `packages/server/src/db/entity-defs.ts`. The recipe projector that turns
 * a stored EntityDefinition into the runtime SyncRecipe shape lives in
 * `./projector.ts` (forthcoming in this phase).
 */

export {
    BUNDLED_SCD2_STRATEGIES,
    bundledStrategyById
} from "./bundled-strategies.js"
export { diffEntityDefinitions } from "./diff.js"
export {
    findEntityTableOrderViolations,
    listEntityTableOrderEdges,
    orderEntityTables,
    orderEntityTablesDetailed
} from "./order.js"
export { projectRecipe, type ProjectedSyncRecipe } from "./projector.js"
export {
    resolveEffectiveScd2
} from "./strategy-resolver.js"
export * from "./types.js"
export {
    isIdentifier,
    isSchemaQualifiedTable,
    looksUnsafeSqlFragment, validateEntityDefinition,
    validateScd2Strategy
} from "./validate.js"

