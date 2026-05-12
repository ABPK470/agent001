/**
 * Agent package barrel export.
 *
 * Everything other packages need to run governed agents.
 */

// Core agent
export { Agent } from "./agent.js"

// Types
export {
    DROP_PRIORITY,
    NEVER_DROP_SECTIONS,
    SECTION_WEIGHTS
} from "./types.js"
export type {
    AgentConfig,
    LLMClient,
    LLMResponse,
    Message,
    PromptBudgetSection,
    TokenUsage,
    Tool,
    ToolCall
} from "./types.js"

// Governance
export {
    createEngineServices, createToolStep, governTool, printGovernanceReport,
    runGoverned
} from "./governance/governance.js"
export type { EngineServices, GovernedResult, GovernToolOptions, RunState } from "./governance/governance.js"

// Retry
export { isRetryableError, TOOL_RETRY_POLICY, withToolRetry } from "./recovery/retry.js"
export type { ToolRetryPolicy, ToolRetryResult } from "./recovery/retry.js"

// Recovery & resilience (ported from agenc-core)
export { ToolFailureCircuitBreaker } from "./recovery/circuit-breaker.js"
export type { CircuitBreakerConfig } from "./recovery/circuit-breaker.js"
export { applyPromptBudget, derivePromptBudgetPlan } from "./context/prompt-budget.js"
export type { PromptBudgetAllocationResult, PromptBudgetConfig, PromptBudgetDiagnostics } from "./context/prompt-budget.js"
export { buildRecoveryHints, buildSemanticToolCallKey, computeQualityProxy, didToolCallFail, extractToolFailureText } from "./recovery/recovery.js"
export type { QualityProxyInput, RecoveryHint, ToolCallRecord } from "./recovery/recovery.js"

// Tool contract guidance (agenc-core enhancement)
export { applyToolContractGuidance, resolveToolContractGuidance } from "./tool-helpers/tool-contract-guidance.js"
export type { AppliedToolContractGuidance, ToolContractContext, ToolContractEnforcement, ToolContractGuidance, ToolContractLifetime } from "./tool-helpers/tool-contract-guidance.js"

// Context compaction (ArtifactCompactionState + LLMStatefulResumeAnchor)
export {
    applyFullCompaction,
    buildResumeAnchorMessage,
    extractCompactionState,
    shouldApplyFullCompaction
} from "./context/context-compaction.js"
export type { ArtifactCompactionState, CompactedFileRecord } from "./context/context-compaction.js"

// Context management (message compaction & truncation)
export { compactMessages, estimateTokens, truncateMessages } from "./context/context-management.js"
export type { TruncationResult } from "./context/context-management.js"

// System prompt
export { ABI_SYNC_SECTION, DEFAULT_SYSTEM_PROMPT } from "./loop/system-prompt.js"

// Delegation bandit learning (agenc-core enhancement)
export {
    DelegationBanditTuner,
    getGlobalDelegationBanditTuner,
    setGlobalDelegationBanditTuner
} from "./delegation/delegation-learning.js"
export type { BanditArm, BanditArmId, DelegationTrajectoryRecord } from "./delegation/delegation-learning.js"

// Tool utils (ported from agenc-core tool-loop + tool-utils)
export {
    checkToolLoopStuckDetection,
    enrichToolResultMetadata,
    evaluateToolRoundBudgetExtension,
    executeToolWithTimeout,
    summarizeToolRoundProgress
} from "./tool-helpers/tool-utils.js"
export type {
    RoundStuckState,
    StuckDetectionResult,
    ToolCallPermissionResult,
    ToolExecutionConfig,
    ToolExecutionResult,
    ToolLoopState,
    ToolRoundBudgetExtensionResult,
    ToolRoundProgressSummary
} from "./tool-helpers/tool-utils.js"

// Delegation decision (ported from agenc-core delegation-decision.ts)
export { assessDelegationDecision, resolveDelegationDecisionConfig } from "./delegation/delegation-decision.js"
export type {
    DelegationDecision,
    DelegationDecisionConfig,
    DelegationDecisionInput,
    DelegationDecisionReason,
    DelegationHardBlockedTaskClass,
    DelegationSubagentStepProfile
} from "./delegation/delegation-decision.js"

// Constants (ported from agenc-core chat-executor-constants.ts)
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
} from "./constants.js"

// Additional types
export { ChatBudgetExceededError } from "./types.js"
export type { ChatCallUsageRecord, StopReason, ToolKillManager } from "./types.js"

// Engine (re-export governance infrastructure for server)
export {
    approvalRequired, AuditService, cancelRun,
    completeRun,
    completeStep,
    createRun,
    failRun,
    failStep, Learner,
    MemoryAuditRepository,
    MemoryEventBus,
    MemoryExecutionRecordRepository,
    MemoryRunRepository,
    PolicyEffect,
    PolicyViolationError,
    RulePolicyEvaluator, runCompleted,
    runFailed,
    runStarted, RunStatus, startPlanning,
    startRunning,
    startStep,
    stepCompleted,
    stepFailed,
    stepStarted, StepStatus
} from "./engine/index.js"
export type {
    AgentRun,
    ApprovalRequired,
    AuditEntry,
    DomainEvent,
    ExecutionRecord,
    PolicyRule,
    Step
} from "./engine/index.js"

// LLM clients
export { DatabricksClient } from "./llm/databricks.js"
export { OpenAIClient } from "./llm/openai.js"

// Built-in tools
export { askUserTool, setAskUserResolver } from "./tools/ask-user.js"
export type { AskUserResolver } from "./tools/ask-user.js"
export { browseWebTool, closeAllBrowserSessions, setBrowseKillSignal } from "./tools/browse-web.js"
export { browserCheckTool, setBrowserCheckCwd, setBrowserCheckExecutor } from "./tools/browser-check.js"
export type { BrowserCheckResult } from "./tools/browser-check.js"
export { searchCatalogTool } from "./tools/catalog-search.js"
export { buildCatalog, getCatalog, getCatalogPromptSummary, hasCatalog, loadLineage } from "./tools/catalog.js"
export type { CatalogBuildOptions, CatalogGraph, CatalogStats, CatalogTable, ConceptNode, ConceptPathEdge, ConceptPathResult, ConceptPathStep, ImplicitEdge, ViewLineage } from "./tools/catalog.js"
export { createDelegateTool, createDelegateTools, spawnChildForPlan } from "./tools/delegate.js"
export type { DelegateContext, ResolvedAgent } from "./tools/delegate.js"
export { fetchUrlTool, setFetchKillSignal } from "./tools/fetch-url.js"
export {
    appendFileTool, listDirectoryTool, readFileTool, replaceInFileTool, setBasePath, writeFileTool
} from "./tools/filesystem.js"
export { inspectDefinitionTool } from "./tools/mssql-inspector.js"
export { profileDataTool } from "./tools/mssql-profiler.js"
export { discoverRelationshipsTool } from "./tools/mssql-relationships.js"
export {
    closeMssqlPool, exportQueryToFileTool, getDefaultMssqlConnectionName, getMssqlConfig, getPool as getMssqlPool, mssqlSchemaTool, mssqlTool, runWithMssqlKillSignal, setDefaultMssqlConnection, setMssqlConfig, setMssqlConfigs, setMssqlKillSignal, setMssqlWriteEnabled
} from "./tools/mssql.js"
export { searchFilesTool, setSearchBasePath } from "./tools/search-files.js"
export { setShellCwd, setShellExecutor, setShellSandboxStrict, setShellSignal, shellTool } from "./tools/shell.js"
export type { ShellExecResult } from "./tools/shell.js"
export { compareCatalogsTool, listEnvironmentsTool, syncExecuteTool, syncPreviewTool } from "./tools/sync-tools.js"
export { thinkTool } from "./tools/think.js"

// ── Sync subsystem (environments, recipes, plans, orchestration) ─
export { detectCatalogDrift, tableHasTriggers, type CatalogDriftResult } from "./sync/catalog-drift.js"
export { getEnvironment, getEnvironments, setEnvironments, setupEnvironments, type EnvRole, type SyncEnvironment } from "./sync/environments.js"
export {
    configureSyncOrchestrator, executeSync, previewSync, searchEntities, setSyncEventSink, setSyncRunSink,
    type EntitySearchResult, type ExecuteOptions, type ExecuteProgress, type PreviewInput, type SyncEvent, type SyncEventSink, type SyncRunFinishInput, type SyncRunSink, type SyncRunStartInput
} from "./sync/orchestrator.js"
export {
    allocPlanId, configurePlanStore, deletePlan, loadPlan, planTooOldToExecute, savePlan,
    type SyncPlan, type SyncPlanConflict, type SyncPlanGraph, type SyncPlanGraphNode, type SyncPlanRowSample, type SyncPlanTable, type SyncPlanTableCounts, type SyncPlanTotals
} from "./sync/plan-store.js"
export {
    clearSyncRecipesCache, getRecipe, instantiatePredicate, loadSyncRecipes,
    type DiscoverySource, type EntityType, type SyncRecipe, type SyncRecipeBundle, type SyncRecipeDiscrepancy, type SyncRecipeTable
} from "./sync/recipes.js"

// ── Planner platform-error helpers (server-side enrichment of opaque user
//    answers with run reference + operator-only logging) ─
export {
    detectInternalFailure,
    detectPlatformUnconfigured,
    fillRunReference,
    GENERIC_FAILURE_PREFIX,
    isGenericFailureAnswer,
    isPlatformUnconfiguredAnswer,
    isPolishedFailureAnswer,
    isUserSafeFailureAnswer,
    markPolishedFailure,
    PLATFORM_UNCONFIGURED_PREFIX,
    POLISHED_FAILURE_MARKER,
    synthesizeGenericFailureAnswer,
    type InternalFailureHit,
    type PlatformUnconfiguredHit
} from "./planner/platform-errors.js"

export {
    mapFailureKindForPolish,
    polishFailureForUser,
    type PolishFailureInput
} from "./planner/polish-failure.js"

