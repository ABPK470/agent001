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
  content: string | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
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

export class OpenAIClient implements LLMClient {
  private readonly apiKey: string
  private readonly model: string
  private readonly baseUrl: string

  constructor(opts: { apiKey: string; model?: string; baseUrl?: string }) {
    this.apiKey = opts.apiKey
    this.model = opts.model ?? "gpt-4o"
    this.baseUrl = opts.baseUrl ?? "https://api.openai.com"
  }

  async chat(messages: Message[], tools: Tool[], opts?: { signal?: AbortSignal }): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(formatMessage),
      max_completion_tokens: opts?.maxTokens ?? 16384,
    }

    if (tools.length > 0) {
      body.tools = tools.map(formatTool)
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

function formatMessage(msg: Message): OpenAIMessage {
  if (msg.role === "assistant" && msg.toolCalls?.length) {
    return {
      role: "assistant",
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

  if (msg.role === "tool") {
    return {
      role: "tool",
      content: msg.content,
      tool_call_id: msg.toolCallId,
    }
  }

  return { role: msg.role, content: msg.content }
}

function formatTool(tool: Tool): OpenAITool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}
