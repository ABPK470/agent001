/**
 * GitHub Copilot LLM client — uses GitHub Models API.
 *
 * With Copilot Pro, you get access to GitHub Models at no extra cost.
 * The API is OpenAI-compatible — same JSON format for messages and tools.
 *
 * Auth: uses your GITHUB_TOKEN (personal access token).
 * If not set, tries to get it from the GitHub CLI (`gh auth token`).
 */

import type { LLMClient, LLMResponse, Message, Tool, ToolCall } from "@agent001/agent"
import { execSync } from "node:child_process"

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { __raw: raw, __parseError: true }
  }
}

export class CopilotClient implements LLMClient {
  private _token: string | null
  private readonly model: string
  private readonly baseUrl: string

  constructor(opts?: { token?: string, model?: string, baseUrl?: string }) {
    this._token = opts?.token ?? tryResolveToken()
    this.model = opts?.model ?? "gpt-4o"
    this.baseUrl = opts?.baseUrl ?? "https://models.inference.ai.azure.com"
  }

  private get token(): string {
    if (!this._token) {
      this._token = resolveToken()
    }
    return this._token
  }

  async chat(messages: Message[], tools: Tool[]): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(formatMessage),
    }

    if (tools.length > 0) {
      body.tools = tools.map(formatTool)
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`GitHub Models API error ${res.status}: ${text}`)
    }

    const data = (await res.json()) as {
      choices: Array<{
        message: {
          content: string | null
          tool_calls?: Array<{
            id: string
            type: "function"
            function: { name: string, arguments: string }
          }>
        }
      }>
      usage?: {
        prompt_tokens: number
        completion_tokens: number
        total_tokens: number
      }
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

// ── Token resolution ─────────────────────────────────────────────

/** Try to resolve token, return null if unavailable. */
function tryResolveToken(): string | null {
  const envToken = process.env["GITHUB_TOKEN"]
  if (envToken) return envToken

  try {
    const cliToken = execSync("gh auth token", { encoding: "utf-8" }).trim()
    if (cliToken) return cliToken
  } catch {
    // gh CLI not available or not authenticated
  }

  return null
}

/** Resolve token or throw — called on first LLM call. */
function resolveToken(): string {
  const token = tryResolveToken()
  if (token) return token

  throw new Error(
    "GitHub token required for Copilot LLM access.\n\n" +
    "Set one of these:\n" +
    "  export GITHUB_TOKEN=ghp_...\n" +
    "  gh auth login\n\n" +
    "Requires GitHub Copilot Pro subscription.\n" +
    "Get a token at: https://github.com/settings/tokens",
  )
}

// ── Format helpers (OpenAI-compatible) ───────────────────────────

interface ApiMessage {
  role: string
  content: string | null
  tool_calls?: Array<{
    id: string
    type: "function"
    function: { name: string, arguments: string }
  }>
  tool_call_id?: string
}

function formatMessage(msg: Message): ApiMessage {
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

function formatTool(tool: Tool) {
  return {
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}
