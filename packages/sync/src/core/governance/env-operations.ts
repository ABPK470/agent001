/**
 * Environment operation gates — sync-local permission checks.
 *
 * Mirrors policy-engine dbOperation names but evaluates against the
 * environment's `allowedOperations` list (from sync-environments.json).
 */

import type { EnvOperation, SyncEnvironment } from "../environments.js"

export function assertEnvOperationAllowed(env: SyncEnvironment, operation: EnvOperation): void {
  if (env.allowedOperations.includes(operation)) return
  const allowed = env.allowedOperations.length > 0 ? env.allowedOperations.join(", ") : "none"
  throw new Error(
    `Operation "${operation}" is not allowed on environment "${env.name}". Allowed: ${allowed}.`,
  )
}
