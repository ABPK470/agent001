/**
 * Chat panel rendering density.
 *   - Simple   — collapse internal tool / thinking events; show user prompts
 *                and final assistant answers only
 *   - Detailed — show every trace entry inline
 */
export const ChatMode = {
  Simple:   "simple",
  Detailed: "detailed",
} as const

export type ChatMode = (typeof ChatMode)[keyof typeof ChatMode]

export const CHAT_MODES: ReadonlyArray<ChatMode> = Object.values(ChatMode)

export const isChatMode = (value: unknown): value is ChatMode =>
  typeof value === "string" && (CHAT_MODES as readonly string[]).includes(value)
