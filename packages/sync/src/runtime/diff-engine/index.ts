/**
 * Sync diff engine runtime — I/O drivers for per-table diff.
 */

export { diffTable, buildDependencyGraph } from "./diff-table.js"
export { fetchPkHash, fetchTableColumns } from "./columns.js"
export { detectScopeMisattribution } from "./conflicts.js"
export { fetchSamples, fetchUpdateSamples } from "./samples.js"
export { runQueryWithRetry } from "./sql-query.js"
