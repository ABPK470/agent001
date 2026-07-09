/**
 * UI enum barrel.
 *
 * Wire-format enums (cross server↔UI) live in `@mia/shared-enums` —
 * a zero-dep workspace package — and are re-exported here so UI
 * imports stay package-local. UI-only enums (no wire crossing) live
 * in this folder and are exported alongside.
 *
 * Adding a wire enum: add it to `@mia/shared-enums` and re-export below.
 * Adding a UI-only enum: drop a new file under `packages/ui/src/enums/`
 * (canonical `as const` pattern) and re-export below.
 */
export { isRunStatus, RUN_STATUSES, RunStatus } from "@mia/shared-enums"
export * from "./app-phase.js"
export * from "./chat-mode.js"
export * from "./ioe-tabs.js"

