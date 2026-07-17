/**
 * `@mia/agent` public barrel — the only supported import path outside this package.
 *
 * Story order: domain → ports → runtime host → Agent run → core helpers → tools.
 */

// ── Domain (words + shapes only) ────────────────────────────────────
export * from "./domain/index.js"
export {
  DEFAULT_SUBAGENT_VERIFIER_MIN_CONFIDENCE,
  DEFAULT_TOOL_FAILURE_BREAKER_COOLDOWN_MS,
  DEFAULT_TOOL_FAILURE_BREAKER_THRESHOLD,
  DEFAULT_TOOL_FAILURE_BREAKER_WINDOW_MS,
  HIGH_RISK_TOOLS,
  MAX_CONSECUTIVE_ALL_FAILED_ROUNDS,
  MAX_CONSECUTIVE_IDENTICAL_FAILURES,
  MAX_CONSECUTIVE_SEMANTIC_DUPLICATE_ROUNDS,
  MAX_FINAL_RESPONSE_CHARS,
  MAX_HISTORY_MESSAGES,
  MAX_PROMPT_CHARS_BUDGET,
  MAX_RUNTIME_SYSTEM_HINTS,
  MAX_TOOL_CALL_ARGUMENT_CHARS,
  MAX_TOOL_RESULT_CHARS,
  MUTATION_TOOLS,
  RECOVERY_HINT_PREFIX,
  SAFE_RETRY_TOOLS,
  VERIFICATION_TOOLS
} from "./domain/types/agent-constants.js"
export {
  ChatBudgetExceededError,
  DROP_PRIORITY,
  NEVER_DROP_SECTIONS,
  SECTION_WEIGHTS
} from "./domain/types/agent-types.js"
export type {
  AgentConfig,
  ChatCallUsageRecord,
  ExecutableTool,
  LLMClient,
  LLMResponse,
  Message,
  PromptBudgetSection,
  StopReason,
  TokenUsage,
  Tool,
  ToolCall,
  ToolDefinition,
  ToolKillManager,
  ToolMetadata
} from "./domain/types/agent-types.js"

// ── Tenant (documented ambient exception) ───────────────────────────
export {
  DEFAULT_CATALOG_BOOTSTRAP,
  DEFAULT_TENANT_CONFIG,
  formatTenantConfigBootSummary,
  getTenantConfig,
  isDefaultTenantConfig,
  loadTenantConfigFromEnv,
  loadTenantConfigFromFile,
  resetTenantConfig,
  resolveTenantConfigPath,
  setTenantConfig
} from "./domain/tenant/tenant-config.js"
export type { CatalogBootstrapMetadata, TenantConfig } from "./domain/tenant/tenant-config.js"
export {
  getPublishedSyncEntityIds,
  loadPublishedSyncEntityIdsFromBundle,
  resetPublishedSyncEntityIds,
  setPublishedSyncEntityIds
} from "./domain/tenant/published-sync-vocabulary.js"
export {
  buildKnownVocabulary,
  catalogSchemaTokens,
  goalContainsDomainKeyword,
  goalContainsSyncEntityId
} from "./domain/tenant/known-vocabulary.js"

// ── Runtime (host + run a goal) ─────────────────────────────────────
export { Agent } from "./runtime/agent.js"
export { configureAgent, makeRunContext } from "./runtime/runtime.js"
export type {
  AgentHost,
  AttachmentMetadata,
  AttachmentStore as AttachmentService,
  ConfigureAgentOptions,
  ConfigureAgentSyncOptions,
  ConfigureMssqlConnection,
  MakeRunContextOptions,
  MssqlCatalogHost,
  MssqlConnectorPool,
  MssqlEntry,
  MssqlPoolProvider,
  RunContext,
  ShellClient
} from "./runtime/runtime.js"
export * from "./runtime/delegate.js"
export * from "./runtime/loop.js"

// ── Ports (contracts + audit/learner adapters) ──────────────────────
export * from "./ports/services/index.js"

// ── Core (pure decisions) ───────────────────────────────────────────
export * from "./core/clarify.js"
export * from "./core/doctrine.js"
export * from "./core/policy.js"
export * from "./core/govern-tools.js"
export * from "./core/recover.js"
export {
  GENERIC_FAILURE_PREFIX,
  PLATFORM_UNCONFIGURED_PREFIX,
  POLISHED_FAILURE_MARKER,
  detectInternalFailure,
  detectPlatformUnconfigured,
  fillRunReference,
  isGenericFailureAnswer,
  isPlatformUnconfiguredAnswer,
  isPolishedFailureAnswer,
  isUserSafeFailureAnswer,
  mapFailureKindForPolish,
  markPolishedFailure,
  polishFailureForUser,
  synthesizeGenericFailureAnswer,
  type InternalFailureHit,
  type PlatformUnconfiguredHit,
  type PolishFailureInput
} from "./core/plan.js"

// ── Tools, LLM, memory ──────────────────────────────────────────────
export * from "./tools/index.js"
export * from "./llm/index.js"
export * from "./memory/index.js"
