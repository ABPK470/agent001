/**
 * Façade — `RunStatus` lives in `@mia/shared-enums` (single source of
 * truth for wire-format enums shared across agent/server/UI). Re-export
 * here so existing `import { RunStatus } from "@mia/agent"` call sites
 * keep working.
 *
 * The transition map for run lifecycle is encoded in
 * `engine/models.ts:74-78` — keep both in sync if you add a state.
 */
export { isRunStatus, RUN_STATUSES, RunStatus } from "@mia/shared-enums"
