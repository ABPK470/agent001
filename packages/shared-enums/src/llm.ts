/**
 * LLM provider interaction kinds — surfaced in UI when a model needs
 * user action (device auth, re-auth, missing configuration, etc.).
 */

export const LlmInteractionKind = {
  DeviceAuth: "device_auth",
  Reauth: "reauth",
  Configure: "configure",
  Waiting: "waiting",
} as const

export type LlmInteractionKind = (typeof LlmInteractionKind)[keyof typeof LlmInteractionKind]

export const LLM_INTERACTION_KINDS: ReadonlyArray<LlmInteractionKind> = Object.values(LlmInteractionKind)

export const isLlmInteractionKind = (value: unknown): value is LlmInteractionKind =>
  typeof value === "string" && (LLM_INTERACTION_KINDS as readonly string[]).includes(value)
