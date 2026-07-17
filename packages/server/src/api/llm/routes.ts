/**
 * LLM configuration transport routes.
 */

import type { LLMClient } from "@mia/agent"
import type { FastifyInstance } from "fastify"
import { buildLlmClient, PROVIDER_DEFAULTS } from "../../platform/llm/registry.js"
import { getLlmConfig, saveLlmConfig } from "../../platform/persistence/sqlite.js"
import { LlmProvider } from "../../shared/enums/llm.js"

const VALID_PROVIDERS: LlmProvider[] = [LlmProvider.CopilotChat, LlmProvider.Databricks]

export function registerLlmRoutes(app: FastifyInstance, onUpdate: (client: LLMClient) => void): void {
  app.get("/api/llm", async () => {
    const cfg = getLlmConfig()
    return {
      provider: cfg.provider,
      model: cfg.model,
      hasApiKey: cfg.api_key.length > 0,
      baseUrl: cfg.base_url,
      updatedAt: cfg.updated_at,
      defaults: PROVIDER_DEFAULTS
    }
  })

  app.put<{
    Body: {
      provider: LlmProvider
      model?: string
      apiKey?: string
      baseUrl?: string
    }
  }>("/api/llm", async (req, reply) => {
    const { provider, model, apiKey, baseUrl } = req.body

    if (!provider || !VALID_PROVIDERS.includes(provider)) {
      reply.code(400)
      return { error: `provider must be one of: ${VALID_PROVIDERS.join(", ")}` }
    }

    const current = getLlmConfig()
    const defaults = PROVIDER_DEFAULTS[provider]

    const newCfg = {
      provider,
      model: model ?? defaults.model,
      api_key: apiKey !== undefined ? apiKey : provider === current.provider ? current.api_key : "",
      base_url: baseUrl !== undefined ? baseUrl : defaults.baseUrl
    }

    saveLlmConfig(newCfg)

    try {
      const client = buildLlmClient({ ...newCfg, updated_at: new Date().toISOString() })
      onUpdate(client)
    } catch (err) {
      reply.code(400)
      return { error: `Failed to build LLM client: ${err instanceof Error ? err.message : err}` }
    }

    return {
      ok: true,
      provider,
      model: newCfg.model,
      hasApiKey: newCfg.api_key.length > 0,
      baseUrl: newCfg.base_url
    }
  })
}
