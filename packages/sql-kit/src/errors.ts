/**
 * Transient executor errors — safe to retry with a fresh pool connection.
 * Shared taxonomy for Sync warehouse work and Bridge drivers.
 */

const TRANSIENT_CODES = new Set([
  "ETIMEOUT",
  "ECONNRESET",
  "ECONNCLOSED",
  "ESOCKET",
  "ECONNREFUSED",
  "ETIMEDOUT",
])

/**
 * Detect transient driver / network errors that are safe to retry.
 * Pool TDS / pg connections can die mid-request; retrying gets a fresh conn.
 */
export function isTransientSqlError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const msg = e.message.toLowerCase()
  const code = (e as { code?: string }).code ?? ""
  if (TRANSIENT_CODES.has(code)) return true
  return (
    msg.includes("connection is closed") ||
    msg.includes("connection lost") ||
    msg.includes("connection reset") ||
    msg.includes("socket hang up") ||
    msg.includes("timeout: request failed to complete") ||
    msg.includes("the connection is closed") ||
    msg.includes("connection terminated") ||
    msg.includes("server closed the connection")
  )
}

/** @deprecated Prefer {@link isTransientSqlError} — name kept for Sync call-site clarity. */
export const isTransientMssqlError = isTransientSqlError
