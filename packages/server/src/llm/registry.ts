/**
 * LLM provider registry — builds the right LLMClient from a stored config.
 *
 * Supported providers:
 *   copilot-chat — Copilot Chat API (same as VS Code, full context window)
 *   copilot      — GitHub Models (OpenAI-compatible, 8K token limit)
 *   openai       — OpenAI API or any OpenAI-compatible endpoint
 *   local        — Local model via OpenAI-compatible API (Ollama, LM Studio, etc.)
 */

import { DatabricksClient, OpenAIClient, type LLMClient } from "@mia/agent";
import type { DbLlmConfig } from "../db.js";
import { CopilotChatClient } from "./copilot-chat.js";
import { CopilotClient } from "./copilot.js";
import { getDatabricksHost, getDatabricksToken, isDatabricksConfigured } from "./databricks-broker.js";

/** Default models per provider shown in the UI picker. */
export const PROVIDER_DEFAULTS: Record<string, { model: string; baseUrl: string; placeholder: string }> = {
  "copilot-chat": { model: "gpt-4o",              baseUrl: "",                                   placeholder: "Automatic (Device Flow — authorize once)" },
  copilot:    { model: "gpt-4o",                  baseUrl: "",                                   placeholder: "Automatic (from GITHUB_TOKEN / gh CLI)" },
  openai:     { model: "gpt-4o",                  baseUrl: "https://api.openai.com",             placeholder: "sk-..." },
  local:      { model: "llama3",                  baseUrl: "http://localhost:11434",              placeholder: "none required (or model API key)" },
  databricks: { model: "databricks-claude-sonnet-4", baseUrl: "",                                placeholder: "Automatic (M2M OAuth from .env)" },
}

/**
 * Build an LLMClient from a persisted config row.
 * api_key / base_url may be empty strings — each provider handles its own defaults.
 */
export function buildLlmClient(cfg: DbLlmConfig): LLMClient {
  const { provider, model, api_key, base_url } = cfg

  switch (provider) {
    case "copilot-chat":
      return new CopilotChatClient({
        token: api_key || undefined,
        model: model || "gpt-4o",
      })

    case "copilot":
      return new CopilotClient({
        token:   api_key || undefined,
        model:   model || "gpt-4o",
        baseUrl: base_url || undefined,
      })

    case "openai":
      return new OpenAIClient({
        apiKey:  api_key,
        model:   model || "gpt-4o",
        baseUrl: base_url || undefined,
      })

    case "local":
      // Local models expose an OpenAI-compatible endpoint.
      // Ollama: http://localhost:11434/v1  (no auth needed)
      // LM Studio: http://localhost:1234/v1
      return new OpenAIClient({
        apiKey:  api_key || "local",          // most local servers ignore the key
        model:   model || "llama3",
        baseUrl: base_url || "http://localhost:11434",
      })

    case "databricks":
      if (!isDatabricksConfigured()) {
        throw new Error(
          "Databricks provider selected but DATABRICKS_HOST / DATABRICKS_CLIENT_ID / DATABRICKS_CLIENT_SECRET are not set in .env",
        )
      }
      return new DatabricksClient({
        host:     base_url || getDatabricksHost(),
        endpoint: model    || process.env["DATABRICKS_DEFAULT_ENDPOINT"] || "databricks-claude-sonnet-4",
        getToken: getDatabricksToken,
      })

    default:
      throw new Error(`Unknown LLM provider: ${provider}`)
  }
}
