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

  async chat(messages: Message[], tools: Tool[]): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(formatMessage),
    }

    if (tools.length > 0) {
      body.tools = tools.map(formatTool)
    }

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`OpenAI API error ${res.status}: ${text}`)
    }

    const data = (await res.json()) as {
      choices: Array<{
        message: {
          content: string | null
          tool_calls?: OpenAIToolCall[]
        }
      }>
    }

    const choice = data.choices[0].message

    return {
      content: choice.content,
      toolCalls: (choice.tool_calls ?? []).map(
        (tc): ToolCall => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
        }),
      ),
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
