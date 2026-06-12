/** Thread kind — distinguishes sidebar conversations from the widget workspace. */
export const ThreadKind = {
  Conversation: "conversation",
  Workspace: "workspace"
} as const

export type ThreadKind = (typeof ThreadKind)[keyof typeof ThreadKind]

export const THREAD_KIND_VALUES = Object.values(ThreadKind) as ThreadKind[]

export function isThreadKind(value: unknown): value is ThreadKind {
  return typeof value === "string" && (THREAD_KIND_VALUES as readonly string[]).includes(value)
}
