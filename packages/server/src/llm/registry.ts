/**
 * LLM provider registry — builds the right LLMClient from a stored config.
 *
 * Supported providers (intranet-only deployment, no third-party SaaS):
 *   copilot-chat — Copilot Chat API (Device Flow, full context window)
 *   databricks   — Foundation Model APIs over corporate Databricks workspace
 *
 * Removed (do not re-add — see commit history):
 *   copilot      — GitHub Models. Token-capped, redundant with copilot-chat.
 *   openai       — Direct OpenAI SaaS. Out of policy for intranet deployments.
 *   anthropic    — UI-only stub, never had a server-side implementation.
 *   local        — Out of policy. The OpenAICompatibleClient class is retained
 *                  as the wire-format base for DatabricksClient only.
 */

import { DatabricksClient, type LLMClient } from "@mia/agent"
import type { DbLlmConfig } from "../adapters/persistence/sqlite.js"
import { CopilotChatClient } from "./copilot-chat.js"
import { getDatabricksHost, getDatabricksToken, isDatabricksConfigured } from "./databricks-broker.js"

/** Default model used when no override is set. */
export const DEFAULT_MODEL = "gpt-5.4"

/** Default models per provider shown in the UI picker. */
export const PROVIDER_DEFAULTS: Record<string, { model: string; baseUrl: string; placeholder: string }> = {
  "copilot-chat": { model: DEFAULT_MODEL,                  baseUrl: "", placeholder: "Automatic (Device Flow — authorize once)" },
  databricks:     { model: "databricks-claude-sonnet-4",   baseUrl: "", placeholder: "Automatic (M2M OAuth from .env)" },
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
        model: model || DEFAULT_MODEL,
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
      throw new Error(`Unknown LLM provider: ${provider}. Allowed: copilot-chat, databricks.`)
  }
}
