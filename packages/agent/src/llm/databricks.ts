/**
 * Databricks LLM client — serving endpoint invocations API.
 *
 *   POST {host}/serving-endpoints/{endpoint}/invocations
 *
 * Request/response use the OpenAI chat format (messages, tools). Auth is PAT
 * or M2M OAuth — see server databricks-broker for token acquisition.
 */

import type { LLMClient, LLMResponse, Message, Tool } from "../domain/types/agent-types.js"
import {
  consumeOpenAICompatibleSSE,
  formatOpenAICompatibleMessage,
  formatOpenAICompatibleTools,
  parseOpenAICompatibleResponse
} from "./openai-compat.js"

export class DatabricksClient implements LLMClient {
  private readonly host: string
  private readonly endpoint: string
  private readonly getToken: () => Promise<string>

  constructor(opts: {
    host: string
    endpoint: string
    getToken: () => Promise<string>
  }) {
    this.host = opts.host.replace(/\/$/, "")
    this.endpoint = opts.endpoint
    this.getToken = opts.getToken
  }

  async chat(
    messages: Message[],
    tools: Tool[],
    opts?: {
      signal?: AbortSignal
      maxTokens?: number
      temperature?: number
      onToken?: (token: string) => void
      onFirstToolCallDelta?: () => void
    }
  ): Promise<LLMResponse> {
    if (opts?.onToken) return this.chatStream(messages, tools, opts)
    return this.chatComplete(messages, tools, opts)
  }

  private async chatStream(
    messages: Message[],
    tools: Tool[],
    opts: {
      signal?: AbortSignal
      maxTokens?: number
      temperature?: number
      onToken?: (token: string) => void
      onFirstToolCallDelta?: () => void
    }
  ): Promise<LLMResponse> {
    const token = await this.getToken()
    const url = `${this.host}/serving-endpoints/${this.endpoint}/invocations`
    const tokenSource = process.env["DATABRICKS_TOKEN"] ? "pat" : "m2m"
    console.debug(`[databricks] POST ${url} tokenSource=${tokenSource} stream=true`)

    const body: Record<string, unknown> = {
      messages: messages.map((m) => formatOpenAICompatibleMessage(m, true)),
      max_completion_tokens: opts?.maxTokens ?? 16384,
      stream: true,
      stream_options: { include_usage: true }
    }
    if (opts?.temperature !== undefined) body.temperature = opts.temperature
    if (tools.length > 0) body.tools = formatOpenAICompatibleTools(tools)

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "json",
        Authorization: `Bearer ${token}`,
        Accept: "text/event-stream"
      },
      body: JSON.stringify(body),
      signal: opts?.signal
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Databricks API error ${res.status}: ${text}`)
    }
    if (!res.body) {
      throw new Error("Databricks API returned an empty streaming body")
    }

    const streamed = await consumeOpenAICompatibleSSE(res.body, {
      onToken: opts.onToken,
      onFirstToolCallDelta: opts.onFirstToolCallDelta
    })
    if (streamed.finishReason === "length") {
      throw new Error(
        "LLM response truncated (finish_reason=length). The model hit its completion token limit before finishing."
      )
    }
    return {
      content: streamed.content || null,
      toolCalls: streamed.toolCalls,
      usage: streamed.usage
    }
  }

  private async chatComplete(
    messages: Message[],
    tools: Tool[],
    opts?: {
      signal?: AbortSignal
      maxTokens?: number
      temperature?: number
      onToken?: (token: string) => void
      onFirstToolCallDelta?: () => void
    }
  ): Promise<LLMResponse> {
    const token = await this.getToken()
    const url = `${this.host}/serving-endpoints/${this.endpoint}/invocations`
    const tokenSource = process.env["DATABRICKS_TOKEN"] ? "pat" : "m2m"
    console.debug(`[databricks] POST ${url} tokenSource=${tokenSource}`)

    const body: Record<string, unknown> = {
      messages: messages.map((m) => formatOpenAICompatibleMessage(m, true)),
      max_completion_tokens: opts?.maxTokens ?? 16384
    }
    if (opts?.temperature !== undefined) body.temperature = opts.temperature
    if (tools.length > 0) body.tools = formatOpenAICompatibleTools(tools)

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "json",
        Authorization: `Bearer ${token}`,
        Accept: "json"
      },
      body: JSON.stringify(body),
      signal: opts?.signal
    })

    const text = await res.text()
    if (!res.ok) {
      throw new Error(`Databricks API error ${res.status}: ${text}`)
    }

    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch (err: unknown) { console.error("[mia]", err) }

    if (parsed && typeof parsed === "object" && "choices" in parsed) {
      const response = parseOpenAICompatibleResponse(parsed)
      if (opts?.onToken && response.content) opts.onToken(response.content)
      return response
    }

    const fallbackContent = typeof parsed === "string" ? parsed : JSON.stringify(parsed)
    if (opts?.onToken && fallbackContent) opts.onToken(fallbackContent)
    return { content: fallbackContent || null, toolCalls: [], usage: undefined }
  }
}
