/**
 * Agent package barrel — the public face of `@mia/agent`.
 *
 * Re-exports happen one cluster at a time. Outside this package, never
 * import from `packages/agent/src/<cluster>/<file>.js` directly — always
 * through here or through the cluster's `index.ts`.
 */

// ── Core ────────────────────────────────────────────────────────────
export { AgentRuntime } from "../agent-runtime.js"
export type { AgentRuntimeOptions, AttachmentMetadata, AttachmentService, BrowserContextHandle, BrowserContextProvider, BrowserCredentialProvider, BrowserGuard, BrowserHandoffProvider } from "../agent-runtime.js"
export { Agent } from "../agent/index.js"
export { configureAgent, getActiveAgentHost, setActiveAgentHost } from "../host/index.js"
export type { AgentHost, ConfigureAgentOptions } from "../host/index.js"

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
} from "../constants.js"
export {
    ChatBudgetExceededError, DROP_PRIORITY,
    NEVER_DROP_SECTIONS,
    SECTION_WEIGHTS
} from "../types.js"
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
} from "../types.js"

// ── Clusters (one barrel per cluster) ───────────────────────────────
export * from "../clarify/index.js"
export * from "../context/index.js"
export * from "../delegation/index.js"
export * from "../doctrine/index.js"
export * from "../domain/index.js"
export * from "../governance/index.js"
export * from "../llm/index.js"
export * from "../loop/index.js"
export * from "../recovery/index.js"
export * from "../sync/index.js"
export * from "../tools/_helpers/index.js"
export * from "../tools/index.js"

// ── Tenant configuration ────────────────────────────────────────────
export {
    DEFAULT_TENANT_CONFIG,
    getTenantConfig,
    isDefaultTenantConfig,
    loadTenantConfigFromEnv,
    resetTenantConfig,
    setTenantConfig
} from "../tenant/config.js"
export type { TenantConfig } from "../tenant/config.js"

// Renamed re-export preserved for back-compat with @mia/server.
export { getPool as getMssqlPool } from "../tools/index.js"

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
} from "../planner/index.js"
