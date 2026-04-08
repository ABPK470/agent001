/**
 * Core types for the AI agent.
 *
 * This is the vocabulary every agent uses, regardless of which LLM or tools:
 *   Message  — a chat turn (system / user / assistant / tool)
 *   Tool     — something the agent can do (function + schema)
 *   ToolCall — the LLM's request to invoke a tool
 *   LLMClient — the "brain" interface (swap OpenAI, Anthropic, local, etc.)
 */

// ── Prompt budget ────────────────────────────────────────────────

/**
 * Tags for prompt sections — determines truncation priority.
 *
 * Inspired by agenc-core's PromptBudgetSection.
 * "never-drop" sections survive any budget pressure.
 * Droppable sections are removed newest-first (runtime, memory)
 * or oldest-first (history) when the context window fills up.
 */
export type PromptBudgetSection =
  | "system_anchor"     // Base prompt + env — NEVER dropped
  | "system_runtime"    // Capabilities, workspace context — droppable
  | "memory_working"    // Recent turns — droppable
  | "memory_episodic"   // Session summaries — droppable
  | "memory_semantic"   // Long-lived knowledge — droppable
  | "history"           // Conversation history — droppable, oldest-first
  | "user"              // Current user message — NEVER dropped

/** Sections that must never be dropped during truncation. */
export const NEVER_DROP_SECTIONS: ReadonlySet<PromptBudgetSection> = new Set([
  "system_anchor",
  "user",
])

/**
 * Drop priority order — first to drop → last to drop.
 * When over budget, we try dropping sections in this order.
 */
export const DROP_PRIORITY: readonly PromptBudgetSection[] = [
  "memory_semantic",    // Oldest knowledge, least time-sensitive
  "memory_episodic",    // Session summaries
  "system_runtime",     // Capabilities / workspace
  "memory_working",     // Recent turns (valuable but replaceable)
  "history",            // Conversation — drop oldest first
]

/**
 * Default budget weights per section (fraction of total context).
 * Matches agenc-core allocation with minor adjustments.
 */
export const SECTION_WEIGHTS: Readonly<Record<PromptBudgetSection, number>> = {
  system_anchor: 0.20,
  system_runtime: 0.10,
  memory_working: 0.10,
  memory_episodic: 0.06,
  memory_semantic: 0.12,
  history: 0.32,
  user: 0.10,
}

// ── Messages ─────────────────────────────────────────────────────

export interface Message {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  /** Tool calls the assistant wants to make (only on assistant messages). */
  toolCalls?: ToolCall[]
  /** Which tool call this message is the result of (only on tool messages). */
  toolCallId?: string
  /** Budget section tag — used for intelligent truncation. Not sent to LLM. */
  section?: PromptBudgetSection
}

// ── Tool calling ─────────────────────────────────────────────────

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/**
 * A tool the agent can use.
 *
 * This is the core plugin interface. Every tool has:
 *   name        — unique identifier the LLM references
 *   description — tells the LLM when/why to use this tool
 *   parameters  — JSON Schema describing the arguments
 *   execute     — the actual implementation
 */
export interface Tool {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  execute(args: Record<string, unknown>): Promise<string>
}

// ── LLM client ───────────────────────────────────────────────────

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface LLMResponse {
  content: string | null
  toolCalls: ToolCall[]
  usage?: TokenUsage
}

/**
 * The "brain" interface — any LLM that supports tool/function calling.
 *
 * Implement this for OpenAI, Anthropic, local models, etc.
 * The agent doesn't care which model is behind this interface.
 */
export interface LLMClient {
  chat(messages: Message[], tools: Tool[], opts?: { signal?: AbortSignal }): Promise<LLMResponse>
}

// ── Agent config ─────────────────────────────────────────────────

/**
 * Error thrown when cumulative token usage exceeds the session budget.
 * Matches agenc-core's ChatBudgetExceededError.
 */
export class ChatBudgetExceededError extends Error {
  readonly used: number
  readonly limit: number
  constructor(used: number, limit: number) {
    super(`Chat budget exceeded: ${used} / ${limit} tokens`)
    this.name = "ChatBudgetExceededError"
    this.used = used
    this.limit = limit
  }
}

/**
 * Canonical stop reason codes (subset of agenc-core LLMPipelineStopReason).
 */
export type StopReason =
  | "completed"
  | "max_iterations"
  | "budget_exceeded"
  | "aborted"
  | "error"
  | "circuit_breaker"
  | "stuck_loop"

// ── Tool kill manager ────────────────────────────────────────────

/**
 * Allows the user to kill individual tool calls while they are executing.
 * The orchestrator implements this; the agent races tool execution against kill.
 */
export interface ToolKillManager {
  /**
   * Register a tool call as executing.
   * Returns a promise that resolves with the user's steering message
   * when/if the tool call is killed.  Never resolves otherwise.
   */
  register(toolCallId: string, toolName: string): Promise<string>
  /** Unregister when done (tool completed or killed). */
  unregister(toolCallId: string): void
}

/**
 * Record of one model API call (cost attribution).
 * Matches agenc-core ChatCallUsageRecord.
 */
export interface ChatCallUsageRecord {
  readonly phase: "tool_loop" | "planner" | "verifier" | "synthesis" | "evaluator"
  readonly callIndex: number
  readonly tokens: TokenUsage
  readonly durationMs: number
  readonly model?: string
}

export interface AgentConfig {
  /** Max think→act→observe iterations before stopping. Default: 30 */
  maxIterations?: number
  /** System prompt — sets the agent's personality and capabilities. */
  systemPrompt?: string
  /**
   * Structured system messages with section tags.
   * When provided, takes precedence over systemPrompt.
   * Enables budget-aware truncation (agenc-core pattern).
   */
  systemMessages?: Message[]
  /** Print the agent's reasoning to the console. Default: true */
  verbose?: boolean
  /** Called right after the LLM responds, before tools execute. Use for trace/UI updates. */
  onThinking?: (content: string | null, toolCalls: ToolCall[], iteration: number) => void
  /** Called after each tool execution round with current messages for checkpointing. */
  onStep?: (messages: Message[], iteration: number) => void
  /** Called before each LLM API call with the messages + tools being sent, and after with the raw response. */
  onLlmCall?: (data: { phase: "request"; messages: Message[]; tools: Tool[]; iteration: number } | { phase: "response"; response: LLMResponse; iteration: number; durationMs: number }) => void
  /** Called when the agent loop injects a system nudge/guard message. */
  onNudge?: (data: { tag: string; message: string; iteration: number }) => void
  /** AbortSignal for external cancellation. */
  signal?: AbortSignal
  /**
   * Per-tool-call kill manager — allows the user to kill individual tool
   * calls and provide a steering message that replaces the tool result.
   */
  toolKillManager?: ToolKillManager

  // ── Planner options (agenc-core pattern) ──────────────────────

  /** Enable planner-first routing for complex tasks. Default: false */
  enablePlanner?: boolean
  /** Workspace root path (used by planner for child scoping). */
  workspaceRoot?: string
  /** Called with planner/pipeline trace events for UI. */
  onPlannerTrace?: (entry: Record<string, unknown>) => void
  /** Delegation function for planner-spawned children (injected by server). */
  plannerDelegateFn?: (step: import("./planner/types.js").SubagentTaskStep, envelope: import("./planner/types.js").ExecutionEnvelope) => Promise<string>
  /**
   * Completion validator — called when the agent tries to exit (0 tool calls).
   * If it returns a non-null string, that string is injected as a system message
   * and the agent is forced to continue. Fires at most once per run.
   * Used by child agents to enforce code quality before exit.
   */
  completionValidator?: () => Promise<string | null>
}
