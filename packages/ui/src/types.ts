/**
 * UI types — thin re-export of `@mia/shared-types`.
 *
 * Wire-format DTOs (Run, TraceEntry, SyncPlan, etc.) live in
 * `@mia/shared-types` so server emit and UI receive share one source of
 * truth. Wire enums live in `@mia/shared-enums` and are re-exported by
 * shared-types.
 */
export * from "@mia/shared-types"
