/**
 * Server-only enums for the `llm` domain.
 */

/** LLM provider identifier persisted in agents.llm_provider. */
export const LlmProvider = {
  CopilotChat: "copilot-chat",
  Databricks:  "databricks",
} as const

export type LlmProvider = (typeof LlmProvider)[keyof typeof LlmProvider]

export const LLM_PROVIDERS: ReadonlyArray<LlmProvider> = Object.values(LlmProvider)

export const isLlmProvider = (value: unknown): value is LlmProvider =>
  typeof value === "string" && (LLM_PROVIDERS as readonly string[]).includes(value)
