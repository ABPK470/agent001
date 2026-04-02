/**
 * Core types for the AI agent.
 *
 * This is the vocabulary every agent uses, regardless of which LLM or tools:
 *   Message  — a chat turn (system / user / assistant / tool)
 *   Tool     — something the agent can do (function + schema)
 *   ToolCall — the LLM's request to invoke a tool
 *   LLMClient — the "brain" interface (swap OpenAI, Anthropic, local, etc.)
 */

// ── Messages ─────────────────────────────────────────────────────

export interface Message {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  /** Tool calls the assistant wants to make (only on assistant messages). */
  toolCalls?: ToolCall[]
  /** Which tool call this message is the result of (only on tool messages). */
  toolCallId?: string
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

export interface AgentConfig {
  /** Max think→act→observe iterations before stopping. Default: 30 */
  maxIterations?: number
  /** System prompt — sets the agent's personality and capabilities. */
  systemPrompt?: string
  /** Print the agent's reasoning to the console. Default: true */
  verbose?: boolean
  /** Called right after the LLM responds, before tools execute. Use for trace/UI updates. */
  onThinking?: (content: string | null, toolCalls: ToolCall[], iteration: number) => void
  /** Called after each tool execution round with current messages for checkpointing. */
  onStep?: (messages: Message[], iteration: number) => void
  /** AbortSignal for external cancellation. */
  signal?: AbortSignal
}
