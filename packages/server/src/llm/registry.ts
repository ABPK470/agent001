/**
 * LLM provider registry — builds the right LLMClient from a stored config.
 *
 * Supported providers:
 *   copilot-chat — Copilot Chat API (same as VS Code, full context window)
 *   copilot      — GitHub Models (OpenAI-compatible, 8K token limit)
 *   openai       — OpenAI API or any OpenAI-compatible endpoint
 *   anthropic    — Anthropic Messages API
 *   local        — Local model via OpenAI-compatible API (Ollama, LM Studio, etc.)
 */

import { AnthropicClient, OpenAIClient, type LLMClient } from "@agent001/agent";
import type { DbLlmConfig } from "../db.js";
import { CopilotChatClient } from "./copilot-chat.js";
import { CopilotClient } from "./copilot.js";

/** Default models per provider shown in the UI picker. */
export const PROVIDER_DEFAULTS: Record<string, { model: string; baseUrl: string; placeholder: string }> = {
  "copilot-chat": { model: "gpt-4o",              baseUrl: "",                                   placeholder: "Automatic (from GITHUB_TOKEN / gh CLI)" },
  copilot:   { model: "gpt-4o",                   baseUrl: "",                                   placeholder: "Automatic (from GITHUB_TOKEN / gh CLI)" },
  openai:    { model: "gpt-4o",                   baseUrl: "https://api.openai.com",             placeholder: "sk-..." },
  anthropic: { model: "claude-sonnet-4-20250514", baseUrl: "",                                   placeholder: "sk-ant-..." },
  local:     { model: "llama3",                   baseUrl: "http://localhost:11434",              placeholder: "none required (or model API key)" },
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

    case "anthropic":
      return new AnthropicClient({
        apiKey: api_key,
        model:  model || "claude-sonnet-4-20250514",
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

    default:
      throw new Error(`Unknown LLM provider: ${provider}`)
  }
}
