/**
 * MessageRole — the four chat-message roles the OpenAI-compatible
 * vocabulary uses: system, user, assistant, tool.
 *
 * Wire string values match the standard exactly so JSON payloads
 * sent to / received from any provider continue to work without
 * conversion.
 */

export const MessageRole = {
  System:    "system",
  User:      "user",
  Assistant: "assistant",
  Tool:      "tool",
} as const

export type MessageRole = (typeof MessageRole)[keyof typeof MessageRole]

export const MESSAGE_ROLES: ReadonlyArray<MessageRole> = Object.values(MessageRole)

export const isMessageRole = (value: unknown): value is MessageRole =>
  typeof value === "string" && (MESSAGE_ROLES as readonly string[]).includes(value)
