/**
 * Local laptop opt-in only. Never enabled by NODE_ENV / hosted staging.
 * Delete `packages/server/src/local-harness/` to remove this harness entirely.
 */

export function isLocalRunSimulateEnabled(): boolean {
  return process.env["MIA_LOCAL_RUN_SIMULATE"] === "1"
}
