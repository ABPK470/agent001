/**
 * Databricks LLM client — calls Databricks Foundation Model serving endpoints
 * via their OpenAI-compatible chat completions API.
 *
 * Databricks serving endpoints expose:
 *   POST {host}/serving-endpoints/{endpoint-name}/invocations
 * AND an OpenAI-compatible alias:
 *   POST {host}/serving-endpoints/{endpoint-name}/v1/chat/completions
 *
 * We use the OpenAI-compatible path so all the OpenAIClient streaming +
 * tool-calling logic works unchanged. The only Databricks-specific bit is
 * the bearer token — fetched fresh from the broker on each chat call so
 * we don't cache an expired token in the client instance.
 *
 * Auth: M2M OAuth (client credentials) — see databricks-broker on the
 * server side for token acquisition + caching.
 */

import type { LLMClient, LLMResponse, Message, Tool } from "../domain/agent-types.js"
import {
  formatOpenAICompatibleMessage,
  formatOpenAICompatibleTools,
  OpenAICompatibleClient,
  parseOpenAICompatibleResponse,
} from "./openai-compat.js"

export class DatabricksClient implements LLMClient {
  private readonly host: string
  private readonly endpoint: string
  private readonly getToken: () => Promise<string>

  constructor(opts: {
    host: string                      // e.g. "https://dbc-...cloud.databricks.com"
    endpoint: string                  // serving-endpoint name
    getToken: () => Promise<string>   // returns a fresh M2M bearer
  }) {
    this.host = opts.host.replace(/\/$/, "")
    this.endpoint = opts.endpoint
    this.getToken = opts.getToken
  }

  async chat(
    messages: Message[],
    tools: Tool[],
    opts?: { signal?: AbortSignal; maxTokens?: number; temperature?: number; onToken?: (token: string) => void },
  ): Promise<LLMResponse> {
    const token = await this.getToken()
    // Databricks serving endpoints expose an OpenAI-compatible API at
    // /serving-endpoints/{endpoint}/v1/chat/completions. We target the
    // per-endpoint base so OpenAIClient's "${baseUrl}/v1/chat/completions"
    // resolves correctly. The "model" field is ignored by Databricks
    // (the endpoint name in the URL determines the model) but we still
    // pass the endpoint name for log-correlation.
    const base = `${this.host}/serving-endpoints/${this.endpoint}`
    // Log the attempted path and token source for easier debugging.
    const tokenSource = process.env["DATABRICKS_TOKEN"] ? "pat" : "m2m"
    console.debug(`[databricks] host=${this.host} endpoint=${this.endpoint} tokenSource=${tokenSource}`)

    const client = new OpenAICompatibleClient({
      apiKey: token,
      model: this.endpoint,
      baseUrl: base,
      enablePromptCaching: true,
    })

    try {
      return await client.chat(messages, tools, opts)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      // If Databricks indicates the OpenAI-compatible alias is not present,
      // fall back to the older /invocations path which many workspaces use.
      if (msg.includes("ENDPOINT_NOT_FOUND") || msg.includes("/invocations") || msg.includes("404")) {
        console.warn(`[databricks] OpenAI-compatible path failed for ${base}/v1/chat/completions — falling back to ${base}/invocations: ${msg}`)
        return await this.invocationsChat(messages, tools, opts, token)
      }
      throw err
    }
  }

  private async invocationsChat(
    messages: Message[],
    tools: Tool[],
    opts: { signal?: AbortSignal; maxTokens?: number; temperature?: number; onToken?: (token: string) => void } | undefined,
    token: string,
  ): Promise<LLMResponse> {
    const url = `${this.host}/serving-endpoints/${this.endpoint}/invocations`
    const body: Record<string, unknown> = {
      model: this.endpoint,
      messages: messages.map((m) => formatOpenAICompatibleMessage(m, true)),
      max_completion_tokens: opts?.maxTokens ?? 16384,
    }
    if (opts?.temperature !== undefined) body.temperature = opts.temperature
    if (tools.length > 0) body.tools = formatOpenAICompatibleTools(tools)

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Accept: "application/json" },
      body: JSON.stringify(body),
      signal: opts?.signal,
    })

    const text = await res.text()
    if (!res.ok) {
      throw new Error(`Databricks invocations error ${res.status}: ${text}`)
    }

    let parsed: unknown = text
    try { parsed = JSON.parse(text) } catch { /* keep raw text */ }

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
