/**
 * SQL-guard enums — severities + semantic families used by the
 * aggregate-correctness guard in `tools/mssql/validation.ts`.
 *
 * Why these are enums (and not inline string literals):
 *   • The same values appear in multiple modules (validation, the
 *     warn-banner formatter, and the test suite). A typo in any one
 *     site silently breaks the contract — the guard would block
 *     nothing or warn forever.
 *   • DB CHECK constraints and downstream consumers (telemetry,
 *     classifier counters) need a single source of truth; that's
 *     exactly the convention the rest of `engine/enums/` follows.
 *
 * Adding a new severity or family: extend the `as const` object — the
 * derived union type and `Object.values(...)` array stay in sync
 * automatically, and the exhaustive-switch sites in validation.ts will
 * fail to compile until they handle the new variant.
 */

/** Severity of an issue surfaced by the aggregate-semantic guard. */
export const AggregateSeverity = {
  Block: "block",
  Warn: "warn"
} as const

export type AggregateSeverity = (typeof AggregateSeverity)[keyof typeof AggregateSeverity]

export const AGGREGATE_SEVERITIES: ReadonlyArray<AggregateSeverity> = Object.values(AggregateSeverity)

export const isAggregateSeverity = (value: unknown): value is AggregateSeverity =>
  typeof value === "string" && (AGGREGATE_SEVERITIES as readonly string[]).includes(value)

/**
 * Semantic family of an aggregate function or an output-alias prefix.
 * Two calls disagree (and are blocked) when their families differ.
 */
export const AggregateFamily = {
  Sum: "sum",
  Avg: "avg",
  Min: "min",
  Max: "max",
  Count: "count"
} as const

export type AggregateFamily = (typeof AggregateFamily)[keyof typeof AggregateFamily]

export const AGGREGATE_FAMILIES: ReadonlyArray<AggregateFamily> = Object.values(AggregateFamily)

export const isAggregateFamily = (value: unknown): value is AggregateFamily =>
  typeof value === "string" && (AGGREGATE_FAMILIES as readonly string[]).includes(value)
