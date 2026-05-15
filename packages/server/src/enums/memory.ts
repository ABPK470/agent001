/**
 * Server-only enums for the `memory` domain.
 */

/** Memory tier — controls retention and retrieval behaviour. */
export const MemoryTier = {
  Working:  "working",
  Episodic: "episodic",
  Semantic: "semantic",
} as const

export type MemoryTier = (typeof MemoryTier)[keyof typeof MemoryTier]

export const MEMORY_TIERS: ReadonlyArray<MemoryTier> = Object.values(MemoryTier)

export const isMemoryTier = (value: unknown): value is MemoryTier =>
  typeof value === "string" && (MEMORY_TIERS as readonly string[]).includes(value)

/** Origin actor that produced a memory entry. */
export const MemorySource = {
  System:   "system",
  Tool:     "tool",
  User:     "user",
  Agent:    "agent",
  External: "external",
} as const

export type MemorySource = (typeof MemorySource)[keyof typeof MemorySource]

export const MEMORY_SOURCES: ReadonlyArray<MemorySource> = Object.values(MemorySource)

export const isMemorySource = (value: unknown): value is MemorySource =>
  typeof value === "string" && (MEMORY_SOURCES as readonly string[]).includes(value)

/** Conversational role attached to a memory entry. */
export const MemoryRole = {
  User:      "user",
  Assistant: "assistant",
  Tool:      "tool",
  System:    "system",
  Summary:   "summary",
} as const

export type MemoryRole = (typeof MemoryRole)[keyof typeof MemoryRole]

export const MEMORY_ROLES: ReadonlyArray<MemoryRole> = Object.values(MemoryRole)

export const isMemoryRole = (value: unknown): value is MemoryRole =>
  typeof value === "string" && (MEMORY_ROLES as readonly string[]).includes(value)

/**
 * Reason an inbound memory candidate was excluded from ingestion.
 *   - LowSalience \u2014 below SALIENCE_THRESHOLD score
 *   - Duplicate   \u2014 isDuplicate() flagged as near-duplicate of an existing entry
 */
export const MemoryIngestionExclusionReason = {
  LowSalience: "low-salience",
  Duplicate:   "duplicate",
} as const

export type MemoryIngestionExclusionReason = (typeof MemoryIngestionExclusionReason)[keyof typeof MemoryIngestionExclusionReason]

export const MEMORY_INGESTION_EXCLUSION_REASONS: ReadonlyArray<MemoryIngestionExclusionReason> = Object.values(MemoryIngestionExclusionReason)

export const isMemoryIngestionExclusionReason = (value: unknown): value is MemoryIngestionExclusionReason =>
  typeof value === "string" && (MEMORY_INGESTION_EXCLUSION_REASONS as readonly string[]).includes(value)

/**
 * Result of a per-run memory validation request (POST /api/runs/:id/memory/flag).
 *   - None          \u2014 no action taken (no matching entry)
 *   - NoMemoryEntry \u2014 the run produced no memory entry; nothing to flag
 *   - Flagged       \u2014 the matching memory entry was flagged for review
 */
export const MemoryValidationAction = {
  None:          "none",
  NoMemoryEntry: "no_memory_entry",
  Flagged:       "flagged",
} as const

export type MemoryValidationAction = (typeof MemoryValidationAction)[keyof typeof MemoryValidationAction]

export const MEMORY_VALIDATION_ACTIONS: ReadonlyArray<MemoryValidationAction> = Object.values(MemoryValidationAction)

export const isMemoryValidationAction = (value: unknown): value is MemoryValidationAction =>
  typeof value === "string" && (MEMORY_VALIDATION_ACTIONS as readonly string[]).includes(value)
