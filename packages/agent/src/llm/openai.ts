/**
 * OpenAI LLM client — calls the Chat Completions API with function calling.
 *
 * Uses raw fetch (no SDK) so you can see exactly what happens:
 *   1. Format messages + tools into OpenAI's JSON format
 *   2. POST to /v1/chat/completions
 *   3. Parse the response — text content and/or tool_calls
 *
 * Works with any OpenAI-compatible API (OpenAI, Azure, local vLLM, etc.)
 */

import { MessageRole } from "../domain/enums/message.js"
import type { LLMClient, LLMResponse, Message, Tool, ToolCall } from "../types.js"

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { __raw: raw, __parseError: true }
  }
}

interface OpenAIMessage {
  role: string
  content: string | null | OpenAIContentBlock[]
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

/**
 * Anthropic-style content block (text + optional cache_control).
 * Databricks Claude serving endpoints (and Anthropic native) honour
 * `cache_control: { type: "ephemeral" }` on the last block of the
 * cached prefix; vanilla OpenAI silently ignores it.
 */
interface OpenAIContentBlock {
  type: "text"
  text: string
  cache_control?: { type: "ephemeral" }
}

interface OpenAIToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

interface OpenAITool {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export class OpenAICompatibleClient implements LLMClient {
  private readonly apiKey: string
  private readonly model: string
  private readonly baseUrl: string
  private readonly enablePromptCaching: boolean

  constructor(opts: { apiKey: string; model?: string; baseUrl?: string; enablePromptCaching?: boolean }) {
    this.apiKey = opts.apiKey
    this.model = opts.model ?? "gpt-4o"
    this.baseUrl = opts.baseUrl ?? "https://api.openai.com"
    this.enablePromptCaching = opts.enablePromptCaching ?? false
  }

  /** Expose the configured model id so token estimators can pick the right factor. */
  get modelHint(): string { return this.model }

  async chat(messages: Message[], tools: Tool[], opts?: { signal?: AbortSignal; maxTokens?: number; temperature?: number; onToken?: (token: string) => void }): Promise<LLMResponse> {
    if (opts?.onToken) return this.chatStream(messages, tools, opts)
    return this.chatComplete(messages, tools, opts)
  }

  private async chatStream(messages: Message[], tools: Tool[], opts: { signal?: AbortSignal; maxTokens?: number; temperature?: number; onToken?: (token: string) => void }): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => formatMessage(m, this.enablePromptCaching)),
      max_completion_tokens: opts?.maxTokens ?? 16384,
      stream: true,
      stream_options: { include_usage: true },
    }
    if (opts?.temperature !== undefined) body.temperature = opts.temperature
    if (tools.length > 0) body.tools = formatTools(tools)

    const maxRetries = 5
    let res: Response | undefined
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: opts?.signal,
      })
      if (res.status !== 429 || attempt === maxRetries) break
      const retryAfter = res.headers.get("retry-after")
      const waitMs = retryAfter ? Number(retryAfter) * 1000 : Math.min(2000 * 2 ** attempt, 60_000)
      await new Promise((r) => setTimeout(r, waitMs))
    }
    if (!res!.ok) { const text = await res!.text(); throw new Error(`OpenAI API error ${res!.status}: ${text}`) }

    let content = ""
    const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>()
    let promptTokens = 0, completionTokens = 0, totalTokens = 0, finishReason: string | null = null
    const reader = res!.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split("\n")
      buf = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        const raw = line.slice(6).trim()
        if (raw === "[DONE]") continue
        let chunk: Record<string, unknown>
        try { chunk = JSON.parse(raw) as Record<string, unknown> } catch { continue }
        const choices = chunk.choices as Array<Record<string, unknown>> | undefined
        const delta = choices?.[0]?.delta as Record<string, unknown> | undefined
        const fr = choices?.[0]?.finish_reason as string | undefined
        if (fr) finishReason = fr
        if (typeof delta?.content === "string" && delta.content) {
          content += delta.content
          opts.onToken?.(delta.content)
        }
        if (Array.isArray(delta?.tool_calls)) {
          for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
            const idx = tc.index as number
            const fn = tc.function as Record<string, unknown> | undefined
            if (!toolCallMap.has(idx)) toolCallMap.set(idx, { id: "", name: "", arguments: "" })
            const entry = toolCallMap.get(idx)!
            if (typeof tc.id === "string") entry.id = tc.id
            if (typeof fn?.name === "string") entry.name += fn.name
            if (typeof fn?.arguments === "string") entry.arguments += fn.arguments
          }
        }
        const usage = chunk.usage as Record<string, number> | undefined
        if (usage?.total_tokens) { promptTokens = usage.prompt_tokens; completionTokens = usage.completion_tokens; totalTokens = usage.total_tokens }
      }
    }
    if (finishReason === "length") {
      throw new Error("LLM response truncated (finish_reason=length). The model hit its completion token limit before finishing. This usually means a tool call argument (like file content) was too large.")
    }
    return {
      content: content || null,
      toolCalls: [...toolCallMap.values()].map((tc): ToolCall => ({ id: tc.id, name: tc.name, arguments: safeParseArgs(tc.arguments) })),
      usage: totalTokens > 0 ? { promptTokens, completionTokens, totalTokens } : undefined,
    }
  }

  private async chatComplete(messages: Message[], tools: Tool[], opts?: { signal?: AbortSignal; maxTokens?: number; temperature?: number }): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => formatMessage(m, this.enablePromptCaching)),
      max_completion_tokens: opts?.maxTokens ?? 16384,
    }
    if (opts?.temperature !== undefined) body.temperature = opts.temperature

    if (tools.length > 0) {
      body.tools = formatTools(tools)
    }

    const maxRetries = 5
    let res: Response | undefined

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: opts?.signal,
      })

      if (res.status !== 429 || attempt === maxRetries) break

      // Respect Retry-After header, fall back to exponential backoff
      const retryAfter = res.headers.get("retry-after")
      const waitMs = retryAfter
        ? Number(retryAfter) * 1000
        : Math.min(2000 * 2 ** attempt, 60_000)
      await new Promise((r) => setTimeout(r, waitMs))
    }

    if (!res!.ok) {
      const text = await res!.text()
      throw new Error(`OpenAI API error ${res!.status}: ${text}`)
    }

    const data = (await res!.json()) as {
      choices: Array<{
        message: {
          content: string | null
          tool_calls?: OpenAIToolCall[]
        }
        finish_reason: string | null
      }>
      usage?: {
        prompt_tokens: number
        completion_tokens: number
        total_tokens: number
      }
    }

    const finish = data.choices[0].finish_reason
    if (finish === "length") {
      throw new Error(
        "LLM response truncated (finish_reason=length). " +
        "The model hit its completion token limit before finishing. " +
        "This usually means a tool call argument (like file content) was too large."
      )
    }

    const choice = data.choices[0].message

    return {
      content: choice.content,
      toolCalls: (choice.tool_calls ?? []).map(
        (tc): ToolCall => ({
          id: tc.id,
          name: tc.function.name,
          arguments: safeParseArgs(tc.function.arguments),
        }),
      ),
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      } : undefined,
    }
  }
}

// ── Format helpers ───────────────────────────────────────────────

function formatMessage(msg: Message, enablePromptCaching = false): OpenAIMessage {
  if (msg.role === MessageRole.Assistant && msg.toolCalls?.length) {
    return {
      role: MessageRole.Assistant,
      content: msg.content,
      tool_calls: msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      })),
    }
  }

  if (msg.role === MessageRole.Tool) {
    return {
      role: MessageRole.Tool,
      content: msg.content,
      tool_call_id: msg.toolCallId,
    }
  }

  // Mark cacheable system/user prefixes for providers that honour
  // Anthropic-style cache_control (Databricks Claude, Anthropic native).
  // Without this the request body is identical to a vanilla OpenAI
  // request, so safe to keep gated behind enablePromptCaching.
  if (enablePromptCaching && msg.cacheHint === "ephemeral" && typeof msg.content === "string" && msg.content.length > 0) {
    return {
      role: msg.role,
      content: [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }],
    }
  }

  return { role: msg.role, content: msg.content }
}

function formatTool(tool: Tool): OpenAITool {
  // NOTE: `JSON.stringify(body)` at the wire layer already produces
  // minified JSON (no separators), so the parameters object does not
  // need a manual minification pass — JS objects don't carry whitespace.
  // Do NOT switch to `JSON.stringify(body, null, 2)` anywhere; that
  // would inflate every request by 30–60%.
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

/**
 * Per-tool-array cache of formatted OpenAI tool descriptors.
 *
 * Tool[] is constructed once at agent boot and reused across every
 * iteration; without this cache `tools.map(formatTool)` re-builds
 * ~30 wrapper objects on every LLM call (and re-serialises them via
 * JSON.stringify when assembling the request body). Keying on the
 * array identity via WeakMap means a new tool registry naturally
 * invalidates without us tracking versions.
 */
const formattedToolCache = new WeakMap<Tool[], OpenAITool[]>()

function formatTools(tools: Tool[]): OpenAITool[] {
  const cached = formattedToolCache.get(tools)
  if (cached) return cached
  const formatted = tools.map(formatTool)
  formattedToolCache.set(tools, formatted)
  return formatted
}

// Exposed for tests only — do not call from production code.
export const __internal = { formatTools, formattedToolCache }
