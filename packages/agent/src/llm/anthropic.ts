/**
 * Anthropic LLM client — calls the Messages API with tool use.
 *
 * Anthropic's format differs from OpenAI:
 *   - System prompt is a top-level param, not a message
 *   - Tool results go as user messages with type: "tool_result"
 *   - Response content is an array of blocks (text + tool_use)
 *
 * Same LLMClient interface — the agent doesn't know the difference.
 */

import type { LLMClient, LLMResponse, Message, Tool, ToolCall } from "../types.js"

export class AnthropicClient implements LLMClient {
  private readonly apiKey: string
  private readonly model: string

  constructor(opts: { apiKey: string; model?: string }) {
    this.apiKey = opts.apiKey
    this.model = opts.model ?? "claude-sonnet-4-20250514"
  }

  async chat(messages: Message[], tools: Tool[]): Promise<LLMResponse> {
    // Anthropic wants system prompt as a separate param
    let systemPrompt: string | undefined
    const apiMessages: AnthropicMessage[] = []

    for (const msg of messages) {
      if (msg.role === "system") {
        systemPrompt = msg.content ?? undefined
        continue
      }

      if (msg.role === "assistant" && msg.toolCalls?.length) {
        const content: AnthropicBlock[] = []
        if (msg.content) content.push({ type: "text", text: msg.content })
        for (const tc of msg.toolCalls) {
          content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments })
        }
        apiMessages.push({ role: "assistant", content })
        continue
      }

      if (msg.role === "tool") {
        // Anthropic: tool results are user messages
        const last = apiMessages[apiMessages.length - 1]
        const block: AnthropicBlock = {
          type: "tool_result",
          tool_use_id: msg.toolCallId!,
          content: msg.content ?? "",
        }
        // Merge consecutive tool results into one user message
        if (last?.role === "user" && Array.isArray(last.content)) {
          ;(last.content as AnthropicBlock[]).push(block)
        } else {
          apiMessages.push({ role: "user", content: [block] })
        }
        continue
      }

      apiMessages.push({ role: msg.role as "user" | "assistant", content: msg.content ?? "" })
    }

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 4096,
      messages: apiMessages,
    }
    if (systemPrompt) body.system = systemPrompt
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }))
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Anthropic API error ${res.status}: ${text}`)
    }

    const data = (await res.json()) as {
      content: Array<
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
      >
    }

    let content: string | null = null
    const toolCalls: ToolCall[] = []

    for (const block of data.content) {
      if (block.type === "text") {
        content = block.text
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input,
        })
      }
    }

    return { content, toolCalls }
  }
}

// ── Anthropic-specific types ─────────────────────────────────────

interface AnthropicBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string
}

interface AnthropicMessage {
  role: "user" | "assistant"
  content: string | AnthropicBlock[]
}
