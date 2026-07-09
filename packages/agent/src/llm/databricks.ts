/**
 * Databricks LLM client — serving endpoint invocations API.
 *
 *   POST {host}/serving-endpoints/{endpoint}/invocations
 *
 * Request/response use the OpenAI chat format (messages, tools). Auth is PAT
 * or M2M OAuth — see server databricks-broker for token acquisition.
 */

import type { LLMClient, LLMResponse, Message, Tool } from "../domain/agent-types.js"
import {
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
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
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
    } catch {
      /* keep raw text */
    }

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
