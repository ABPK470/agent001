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
} from "./governance.js"
export type { EngineServices, GovernedResult, GovernToolOptions, RunState } from "./governance.js"

// Retry
export { isRetryableError, TOOL_RETRY_POLICY, withToolRetry } from "./retry.js"
export type { ToolRetryPolicy, ToolRetryResult } from "./retry.js"

// Recovery & resilience (ported from agenc-core)
export { ToolFailureCircuitBreaker } from "./circuit-breaker.js"
export type { CircuitBreakerConfig } from "./circuit-breaker.js"
export { applyPromptBudget, derivePromptBudgetPlan } from "./prompt-budget.js"
export type { PromptBudgetAllocationResult, PromptBudgetConfig, PromptBudgetDiagnostics } from "./prompt-budget.js"
export { buildRecoveryHints, buildSemanticToolCallKey, computeQualityProxy, didToolCallFail, extractToolFailureText } from "./recovery.js"
export type { QualityProxyInput, RecoveryHint, ToolCallRecord } from "./recovery.js"

// Tool utils (ported from agenc-core tool-loop + tool-utils)
export {
    checkToolLoopStuckDetection,
    enrichToolResultMetadata,
    evaluateToolRoundBudgetExtension,
    executeToolWithTimeout,
    summarizeToolRoundProgress
} from "./tool-utils.js"
export type {
    RoundStuckState,
    StuckDetectionResult,
    ToolCallPermissionResult,
    ToolExecutionConfig,
    ToolExecutionResult,
    ToolLoopState,
    ToolRoundBudgetExtensionResult,
    ToolRoundProgressSummary
} from "./tool-utils.js"

// Delegation decision (ported from agenc-core delegation-decision.ts)
export { assessDelegationDecision, resolveDelegationDecisionConfig } from "./delegation-decision.js"
export type {
    DelegationDecision,
    DelegationDecisionConfig,
    DelegationDecisionInput,
    DelegationDecisionReason,
    DelegationHardBlockedTaskClass,
    DelegationSubagentStepProfile
} from "./delegation-decision.js"

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
export { AnthropicClient } from "./llm/anthropic.js"
export { OpenAIClient } from "./llm/openai.js"

// Built-in tools
export { askUserTool, setAskUserResolver } from "./tools/ask-user.js"
export type { AskUserResolver } from "./tools/ask-user.js"
export { browseWebTool, closeAllBrowserSessions } from "./tools/browse-web.js"
export { browserCheckTool, setBrowserCheckCwd, setBrowserCheckExecutor } from "./tools/browser-check.js"
export type { BrowserCheckResult } from "./tools/browser-check.js"
export { createDelegateTool, createDelegateTools, spawnChildForPlan } from "./tools/delegate.js"
export type { DelegateContext, ResolvedAgent } from "./tools/delegate.js"
export { fetchUrlTool } from "./tools/fetch-url.js"
export {
    listDirectoryTool, readFileTool, replaceInFileTool, setBasePath, writeFileTool
} from "./tools/filesystem.js"
export {
    closeMssqlPool, getMssqlConfig, mssqlSchemaTool, mssqlTool, setMssqlConfig, setMssqlWriteEnabled
} from "./tools/mssql.js"
export { searchFilesTool, setSearchBasePath } from "./tools/search-files.js"
export { setShellCwd, setShellExecutor, setShellSandboxStrict, setShellSignal, shellTool } from "./tools/shell.js"
export type { ShellExecResult } from "./tools/shell.js"
export { thinkTool } from "./tools/think.js"

