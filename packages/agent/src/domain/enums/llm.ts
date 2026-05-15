/**
 * LLM-call lifecycle and agent-runtime phase enums.
 *
 * @module
 */

// ── LLMCallPhase (request/response discriminator on `onLlmCall`) ─────────────
export const LLMCallPhase = {
  Request:  "request",
  Response: "response",
} as const

export type LLMCallPhase = (typeof LLMCallPhase)[keyof typeof LLMCallPhase]

export const LLM_CALL_PHASES: ReadonlyArray<LLMCallPhase> = Object.values(LLMCallPhase)

export const isLLMCallPhase = (value: unknown): value is LLMCallPhase =>
  typeof value === "string" && (LLM_CALL_PHASES as readonly string[]).includes(value)
