/**
 * Agent package barrel — the public face of `@mia/agent`.
 *
 * Re-exports happen one cluster at a time. Outside this package, never
 * import from `packages/agent/src/<cluster>/<file>.js` directly — always
 * through here or through the cluster's `index.ts`.
 */

// ── Runtime Shell ───────────────────────────────────────────────────
export { Agent } from "./application/shell/agent.js"
export { configureAgent, makeRunContext } from "./application/shell/runtime.js"
export type {
    AgentHost, AttachmentMetadata,
    AttachmentStore as AttachmentService, BrowserClient, BrowserContextHandle,
    BrowserContextReader as BrowserContextProvider, CredentialReader as BrowserCredentialProvider,
    BrowserGuard,
    HandoffStore as BrowserHandoffProvider, ConfigureAgentOptions, ConfigureMssqlConnection, MakeRunContextOptions, RunContext, ShellClient
} from "./application/shell/runtime.js"

// ── Types & constants ───────────────────────────────────────────────
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
} from "./domain/agent-constants.js"
export {
    ChatBudgetExceededError, DROP_PRIORITY,
    NEVER_DROP_SECTIONS,
    SECTION_WEIGHTS
} from "./domain/agent-types.js"
export type {
    AgentConfig,
    ChatCallUsageRecord,
    LLMClient,
    LLMResponse,
    Message,
    PromptBudgetSection,
    StopReason,
    TokenUsage,
    Tool,
    ToolCall,
    ToolKillManager
} from "./domain/agent-types.js"

// ── Clusters (one barrel per cluster) ───────────────────────────────
export * from "./application/core/clarify.js"
export * from "./application/core/doctrine.js"
export * from "./application/core/governance.js"
export * from "./application/core/recovery.js"
export * from "./application/shell/delegation.js"
export * from "./application/shell/loop.js"
export * from "./domain/index.js"
export * from "./llm/index.js"
export * from "./memory/index.js"
export * from "./tools/index.js"

// ── Tenant configuration ────────────────────────────────────────────
export {
    DEFAULT_CATALOG_BOOTSTRAP,
    DEFAULT_TENANT_CONFIG,
    getTenantConfig,
    isDefaultTenantConfig,
    loadTenantConfigFromEnv,
    resetTenantConfig,
    setTenantConfig
} from "./application/shell/tenant-config.js"
export type { CatalogBootstrapMetadata, TenantConfig } from "./application/shell/tenant-config.js"

// ── Planner public surface (curated subset; planner has its own index) ─
export {
    detectInternalFailure,
    detectPlatformUnconfigured,
    fillRunReference,
    GENERIC_FAILURE_PREFIX,
    isGenericFailureAnswer,
    isPlatformUnconfiguredAnswer,
    isPolishedFailureAnswer,
    isUserSafeFailureAnswer,
    mapFailureKindForPolish,
    markPolishedFailure,
    PLATFORM_UNCONFIGURED_PREFIX,
    POLISHED_FAILURE_MARKER,
    polishFailureForUser,
    synthesizeGenericFailureAnswer,
    type InternalFailureHit,
    type PlatformUnconfiguredHit,
    type PolishFailureInput
} from "./application/core/planner.js"
