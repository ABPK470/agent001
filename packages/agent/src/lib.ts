/**
 * Agent package barrel export.
 *
 * Everything other packages need to run governed agents.
 */

// Core agent
export { Agent } from "./agent.js"

// Types
export type {
    AgentConfig,
    LLMClient,
    LLMResponse,
    Message,
    TokenUsage,
    Tool,
    ToolCall
} from "./types.js"

// Governance
export {
    createEngineServices, createToolStep, governTool, printGovernanceReport,
    runGoverned
} from "./governance.js"
export type { EngineServices, GovernToolOptions, GovernedResult, RunState } from "./governance.js"

// Retry
export {
    TOOL_RETRY_POLICY, isRetryableError, withToolRetry
} from "./retry.js"
export type { ToolRetryPolicy, ToolRetryResult } from "./retry.js"

// Engine (re-export governance infrastructure for server)
export {
    AuditService,
    Learner,
    MemoryAuditRepository,
    MemoryEventBus,
    MemoryExecutionRecordRepository,
    MemoryRunRepository,
    PolicyEffect,
    PolicyViolationError,
    RulePolicyEvaluator,
    RunStatus,
    StepStatus,
    approvalRequired,
    completeRun,
    completeStep,
    createRun,
    failRun,
    failStep,
    runCompleted,
    runFailed,
    runStarted,
    startPlanning,
    startRunning,
    startStep,
    stepCompleted,
    stepFailed,
    stepStarted
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
export { browserCheckTool, setBrowserCheckCwd } from "./tools/browser-check.js"
export { createDelegateTool, createDelegateTools } from "./tools/delegate.js"
export type { DelegateContext, ResolvedAgent } from "./tools/delegate.js"
export { fetchUrlTool } from "./tools/fetch-url.js"
export {
    listDirectoryTool, readFileTool, setBasePath, writeFileTool
} from "./tools/filesystem.js"
export { setShellCwd, shellTool } from "./tools/shell.js"
export { thinkTool } from "./tools/think.js"

