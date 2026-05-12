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

import type { LLMClient, LLMResponse, Message, Tool } from "../types.js"
import { OpenAIClient } from "./openai.js"

export class DatabricksClient implements LLMClient {
  private readonly host: string
  private readonly endpoint: string
  private readonly getToken: () => Promise<string>

  constructor(opts: {
    host: string                      // e.g. "https://dbc-...cloud.databricks.com"
    endpoint: string                  // serving-endpoint name, e.g. "databricks-claude-sonnet-4"
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
    const client = new OpenAIClient({
      apiKey: token,
      model: this.endpoint,
      baseUrl: `${this.host}/serving-endpoints/${this.endpoint}`,
    })
    return client.chat(messages, tools, opts)
  }
}
