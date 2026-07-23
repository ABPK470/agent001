/**
 * Entity registry — pure decisions.
 */

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
  validateAuthoredExportRoundTrip,
  validateEntityExportable,
} from "./export-validation.js"
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
export {
  hasUnresolvedLegacyPipelineNote,
  isDegradedLegacyFallbackPredicate,
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
export { materializeDefinitionTablesForSchema } from "./materialize-scd2-for-schema.js"
export { materializeScd2PolicyForSchema } from "./scd2-policy.js"
