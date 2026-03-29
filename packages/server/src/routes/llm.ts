/**
 * LLM configuration routes.
 *
 * GET  /api/llm  — current config (api_key redacted)
 * PUT  /api/llm  — update provider / model / api_key / base_url
 *                  returns the new client (triggers hot-swap in server)
 */

import type { LLMClient } from "@agent001/agent"
import type { FastifyInstance } from "fastify"
import { getLlmConfig, saveLlmConfig, type LlmProvider } from "../db.js"
import { buildLlmClient, PROVIDER_DEFAULTS } from "../llm/registry.js"

const VALID_PROVIDERS: LlmProvider[] = ["copilot", "openai", "anthropic", "local"]

export function registerLlmRoutes(
  app: FastifyInstance,
  onUpdate: (client: LLMClient) => void,
): void {
  // Get current config (redact key)
  app.get("/api/llm", async () => {
    const cfg = getLlmConfig()
    return {
      provider: cfg.provider,
      model: cfg.model,
      hasApiKey: cfg.api_key.length > 0,
      baseUrl: cfg.base_url,
      updatedAt: cfg.updated_at,
      defaults: PROVIDER_DEFAULTS,
    }
  })

  // Update config + hot-swap the active LLM client
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

    // Read current config so we can preserve existing api_key if not re-supplied
    const current = getLlmConfig()
    const defaults = PROVIDER_DEFAULTS[provider]

    const newCfg = {
      provider,
      model:   model   ?? defaults.model,
      api_key: apiKey  !== undefined ? apiKey : (provider === current.provider ? current.api_key : ""),
      base_url: baseUrl !== undefined ? baseUrl : defaults.baseUrl,
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
      baseUrl: newCfg.base_url,
    }
  })
}
