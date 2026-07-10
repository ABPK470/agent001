/**
 * Entity registry — public surface.
 */

export {
  DEFAULT_STRATEGIES_ARTIFACT_PATH,
  loadStrategiesArtifact,
  shippedScd2Strategies,
  shippedStrategyById,
} from "../load-strategies-artifact.js"
export { entityDefinitionFromAuthoredSync, ensureEntityScopePlaceholder, scopeFromAuthoredPredicate } from "./from-authored-sync.js"
export { diffEntityDefinitions } from "./diff.js"
export {
  findEntityTableOrderViolations,
  listEntityTableOrderEdges,
  orderEntityTables,
  orderEntityTablesDetailed
} from "./order.js"
export { normalizeEntityDefinition, normalizeTableScope, compileFkPathPredicate } from "./normalize-table-scope.js"
export { projectTablePredicate } from "./project-predicate.js"
export {
  entityIdFromTableName,
  humanizeTableName,
  normalizeQualifiedTableName,
  suggestEntityDraft,
  suggestEntityTable,
  suggestFlowTemplateId,
  suggestIdentityHeuristic,
  type CatalogSnapshotForSuggest,
  type CatalogTableForSuggest,
  type EntityDraftIdentitySuggestion,
  type EntityDraftSuggestion,
  type EntityTableSuggestion,
  catalogSnapshotFromAgentJson,
} from "./suggest-draft.js"
export { resolveEffectiveScd2 } from "./strategy-resolver.js"
export {
  normalizeScd2Override,
  normalizeScd2Strategy,
  SCD2_STRATEGY_PRESETS,
  toScd2TablePolicy,
  type Scd2TablePolicy,
} from "./scd2-policy.js"
export * from "./types.js"
export {
  looksIncompleteScopePredicate,
  resolveReviewPlaceholderPredicate,
} from "./resolve-scope-predicate.js"
export {
  isIdentifier,
  isSchemaQualifiedTable,
  looksUnsafeSqlFragment,
  validateEntityDefinition,
  validateScd2Strategy
} from "./validate.js"
