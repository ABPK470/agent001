/**
 * Copilot Chat LLM client — full Copilot access (no 8K limit).
 *
 * Uses GitHub Device Flow with the VS Code Copilot extension's OAuth client
 * to obtain a token compatible with the Copilot internal API:
 *   1. Device Flow → GitHub OAuth token (cached to ~/.agent001/copilot-token.json)
 *   2. OAuth token → Copilot session token via api.github.com/copilot_internal/v2/token
 *   3. Session token → chat completions via the Copilot endpoint
 *
 * First use: the server console will print a one-time code + URL.
 *   Open the URL in your browser, enter the code, and authorize.
 *   The token is then cached permanently (refresh handled automatically).
 *
 * Requires an active GitHub Copilot Pro/Business/Enterprise subscription.
 */

import type { LLMClient, LLMResponse, Message, Tool, ToolCall } from "@agent001/agent"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { __raw: raw, __parseError: true }
  }
}

/**
 * VS Code Copilot extension's public OAuth client ID.
 * This is the only client ID whose tokens the copilot_internal endpoints accept.
 */
const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98"

const TOKEN_CACHE_DIR = join(homedir(), ".agent001")
const TOKEN_CACHE_PATH = join(TOKEN_CACHE_DIR, "copilot-token.json")

interface CachedOAuthToken {
  access_token: string
  token_type: string
  scope: string
}

interface CopilotSession {
  token: string
  endpoint: string
  expiresAt: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class CopilotChatClient implements LLMClient {
  private readonly model: string
  private session: CopilotSession | null = null
  private oauthToken: string | null = null

  constructor(opts?: { token?: string; model?: string }) {
    this.oauthToken = opts?.token ?? null
    this.model = opts?.model ?? "gpt-4o"
  }

  // ── OAuth token management ───────────────────────────────────

  /**
   * Get a GitHub OAuth token with Copilot scope.
   * Priority: constructor arg → cached file → Device Flow (interactive).
   */
  private async getOAuthToken(): Promise<string> {
    if (this.oauthToken) return this.oauthToken

    // Try loading cached token
    const cached = loadCachedToken()
    if (cached) {
      this.oauthToken = cached
      return cached
    }

    // Interactive Device Flow
    console.log("\n┌─────────────────────────────────────────────┐")
    console.log("│  Copilot Chat — One-time authorization      │")
    console.log("└─────────────────────────────────────────────┘")

    const deviceRes = await fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: `client_id=${COPILOT_CLIENT_ID}&scope=copilot`,
    })

    if (!deviceRes.ok) {
      throw new Error(`Device Flow initiation failed: ${await deviceRes.text()}`)
    }

    const device = (await deviceRes.json()) as {
      device_code: string
      user_code: string
      verification_uri: string
      expires_in: number
      interval: number
    }

    console.log(`\n  1. Open:  ${device.verification_uri}`)
    console.log(`  2. Enter: ${device.user_code}`)
    console.log(`  3. Authorize the GitHub Copilot plugin\n`)
    console.log("  Waiting for authorization...")

    // Poll for completion
    const interval = Math.max(device.interval, 5) * 1000
    const deadline = Date.now() + device.expires_in * 1000

    while (Date.now() < deadline) {
      await sleep(interval)

      const pollRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: `client_id=${COPILOT_CLIENT_ID}&device_code=${device.device_code}&grant_type=urn:ietf:params:oauth:grant-type:device_code`,
      })

      const poll = (await pollRes.json()) as {
        access_token?: string
        token_type?: string
        scope?: string
        error?: string
      }

      if (poll.error === "authorization_pending") continue
      if (poll.error === "slow_down") {
        await sleep(5000)
        continue
      }
      if (poll.error) {
        throw new Error(`Device Flow failed: ${poll.error}`)
      }

      if (poll.access_token) {
        console.log("  ✓ Authorized! Token cached to ~/.agent001/copilot-token.json\n")
        saveCachedToken({
          access_token: poll.access_token,
          token_type: poll.token_type ?? "bearer",
          scope: poll.scope ?? "copilot",
        })
        this.oauthToken = poll.access_token
        return poll.access_token
      }
    }

    throw new Error("Device Flow timed out — please try again.")
  }

  // ── Copilot session (short-lived token) ──────────────────────

  /**
   * Exchange the OAuth token for a short-lived Copilot session token.
   * Caches with 60s expiry buffer.
   */
  private async getSession(): Promise<CopilotSession> {
    const now = Math.floor(Date.now() / 1000)
    if (this.session && this.session.expiresAt > now + 60) {
      return this.session
    }

    const oauthToken = await this.getOAuthToken()

    const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
      headers: {
        Authorization: `token ${oauthToken}`,
        Accept: "application/json",
        "User-Agent": "GithubCopilot/1.255.0",
        "Editor-Version": "vscode/1.96.0",
        "Editor-Plugin-Version": "copilot/1.255.0",
      },
    })

    if (res.status === 401) {
      // Token revoked or expired — clear cache and retry via Device Flow
      clearCachedToken()
      this.oauthToken = null
      this.session = null
      throw new Error(
        "Copilot OAuth token expired or was revoked.\n" +
        "Restart the server to re-authorize via Device Flow.",
      )
    }

    if (!res.ok) {
      const text = await res.text()
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

  // ── LLMClient.chat ──────────────────────────────────────────

  async chat(messages: Message[], tools: Tool[]): Promise<LLMResponse> {
    const session = await this.getSession()

    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(formatMessage),
      max_completion_tokens: 16384,
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

// ── Token cache helpers ──────────────────────────────────────────

function loadCachedToken(): string | null {
  try {
    if (!existsSync(TOKEN_CACHE_PATH)) return null
    const raw = readFileSync(TOKEN_CACHE_PATH, "utf-8")
    const data = JSON.parse(raw) as CachedOAuthToken
    return data.access_token || null
  } catch {
    return null
  }
}

function saveCachedToken(token: CachedOAuthToken): void {
  mkdirSync(TOKEN_CACHE_DIR, { recursive: true })
  writeFileSync(TOKEN_CACHE_PATH, JSON.stringify(token, null, 2), { mode: 0o600 })
}

function clearCachedToken(): void {
  try {
    writeFileSync(TOKEN_CACHE_PATH, "{}", { mode: 0o600 })
  } catch {
    // ignore
  }
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
