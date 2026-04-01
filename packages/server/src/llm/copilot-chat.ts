/**
 * Copilot Chat LLM client — uses the same API that VS Code Copilot uses.
 *
 * Unlike the GitHub Models API (models.inference.ai.azure.com) which has an
 * 8000-token request limit, the Copilot Chat API supports the model's full
 * context window (128K for gpt-4o).
 *
 * Auth flow:
 *   1. GITHUB_TOKEN (or `gh auth token`) → short-lived Copilot session token
 *   2. Session token → Copilot Chat completions endpoint
 *
 * Requires an active GitHub Copilot Pro/Business/Enterprise subscription.
 */

import type { LLMClient, LLMResponse, Message, Tool, ToolCall } from "@agent001/agent"
import { execSync } from "node:child_process"

const TOKEN_EXCHANGE_URL = "https://api.github.com/copilot_internal/v2/token"

interface CopilotSession {
  token: string
  endpoint: string
  expiresAt: number
}

export class CopilotChatClient implements LLMClient {
  private _githubToken: string | null
  private readonly model: string
  private session: CopilotSession | null = null

  constructor(opts?: { token?: string; model?: string }) {
    this._githubToken = opts?.token ?? tryResolveToken()
    this.model = opts?.model ?? "gpt-4o"
  }

  private get githubToken(): string {
    if (!this._githubToken) {
      this._githubToken = resolveToken()
    }
    return this._githubToken
  }

  /**
   * Exchange the GitHub token for a short-lived Copilot session token.
   * Tokens are cached and refreshed when they expire (with a 60s buffer).
   */
  private async getSession(): Promise<CopilotSession> {
    const now = Math.floor(Date.now() / 1000)
    if (this.session && this.session.expiresAt > now + 60) {
      return this.session
    }

    const res = await fetch(TOKEN_EXCHANGE_URL, {
      headers: {
        Authorization: `token ${this.githubToken}`,
        Accept: "application/json",
        "User-Agent": "agent001/1.0",
      },
    })

    if (!res.ok) {
      const text = await res.text()
      if (res.status === 401) {
        throw new Error(
          "GitHub token rejected by Copilot. Ensure you have an active Copilot Pro subscription " +
          "and your token has the `copilot` scope.\n\n" +
          "Try: gh auth refresh --scopes copilot",
        )
      }
      throw new Error(`Copilot token exchange failed (${res.status}): ${text}`)
    }

    const data = (await res.json()) as {
      token: string
      expires_at: number
      endpoints?: { api?: string }
    }

    this.session = {
      token: data.token,
      endpoint: data.endpoints?.api ?? "https://api.individual.githubcopilot.com",
      expiresAt: data.expires_at,
    }

    return this.session
  }

  async chat(messages: Message[], tools: Tool[]): Promise<LLMResponse> {
    const session = await this.getSession()

    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(formatMessage),
    }

    if (tools.length > 0) {
      body.tools = tools.map(formatTool)
    }

    const res = await fetch(`${session.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.token}`,
        "Editor-Version": "vscode/1.96.0",
        "Copilot-Integration-Id": "vscode-chat",
        "Openai-Intent": "conversation-panel",
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()

      // If session expired mid-request, clear and let next call refresh
      if (res.status === 401) {
        this.session = null
      }

      throw new Error(`Copilot Chat API error ${res.status}: ${text}`)
    }

    const data = (await res.json()) as {
      choices: Array<{
        message: {
          content: string | null
          tool_calls?: Array<{
            id: string
            type: "function"
            function: { name: string; arguments: string }
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
          arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
        }),
      ),
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
    }
  }
}

// ── Token resolution (shared logic with copilot.ts) ──────────────

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

function resolveToken(): string {
  const token = tryResolveToken()
  if (token) return token

  throw new Error(
    "GitHub token required for Copilot Chat access.\n\n" +
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
    function: { name: string; arguments: string }
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
