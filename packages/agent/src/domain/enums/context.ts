/**
 * Context-layer enums (prompt budget, history sections, etc).
 */

/** Top-level section of a prompt that participates in the budget plan. */
export const BaseSectionKey = {
  System: "system",
  Memory: "memory",
  History: "history",
  User: "user",
  Other: "other"
} as const

export type BaseSectionKey = (typeof BaseSectionKey)[keyof typeof BaseSectionKey]

export const BASE_SECTION_KEYS: ReadonlyArray<BaseSectionKey> = Object.values(BaseSectionKey)

export const isBaseSectionKey = (value: unknown): value is BaseSectionKey =>
  typeof value === "string" && (BASE_SECTION_KEYS as readonly string[]).includes(value)
