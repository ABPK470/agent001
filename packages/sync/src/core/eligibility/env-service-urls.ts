import type { SyncEnvironment } from "./environments.js"

const LEGACY_SERVICE_KEYS: Record<string, keyof SyncEnvironment> = {
  agent: "agentServiceBaseUrl",
  etl: "etlServiceBaseUrl",
  gate: "gateServiceBaseUrl",
}

/** Resolve a named service base URL — `serviceUrls` map first, then legacy fields. */
export function resolveEnvServiceUrl(env: SyncEnvironment, key: string): string | null {
  const normalizedKey = key.trim().toLowerCase()
  if (!normalizedKey) return null

  const fromMap = env.serviceUrls?.[normalizedKey]
  if (typeof fromMap === "string" && fromMap.trim()) return fromMap.trim()

  const legacyField = LEGACY_SERVICE_KEYS[normalizedKey]
  if (!legacyField) return null
  const legacy = env[legacyField]
  return typeof legacy === "string" && legacy.trim() ? legacy.trim() : null
}

export function normalizeServiceUrls(
  input: Record<string, unknown> | undefined,
): Record<string, string | null> | undefined {
  if (!input || typeof input !== "object") return undefined
  const out: Record<string, string | null> = {}
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim().toLowerCase()
    if (!key) continue
    if (rawValue === null) {
      out[key] = null
      continue
    }
    if (typeof rawValue !== "string") continue
    out[key] = rawValue.trim() || null
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Merge explicit map with legacy agent/etl/gate fields for storage. */
export function mergeServiceUrlFields(env: Partial<SyncEnvironment>): Record<string, string | null> {
  const merged: Record<string, string | null> = { ...(env.serviceUrls ?? {}) }
  for (const [key, field] of Object.entries(LEGACY_SERVICE_KEYS)) {
    const legacy = env[field]
    if (typeof legacy === "string" && legacy.trim()) {
      merged[key] = legacy.trim()
    }
  }
  return merged
}
