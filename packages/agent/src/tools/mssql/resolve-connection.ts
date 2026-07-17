/**
 * Canonical MSSQL connection resolution.
 *
 * The connection identifier surfaced to the LLM and used internally is the
 * **connector id** (the persisted connector's unique slug). When a live
 * `MssqlPoolProvider` is present (production), the list of available
 * connections is read live from the connectors DB via `pools.list()`, and a
 * tool's `connection` argument is matched case-insensitively against both
 * connector ids and connector names (name is an ergonomic alias, not a data
 * fallback — it still resolves through the live provider). When no provider is
 * configured (tests/legacy), resolution falls back to the boot-time
 * `host.mssql.databases` map.
 */

import type { AgentHost } from "../../application/shell/runtime.js"

/** Case-insensitive lookup against a set of registry keys. */
export function lookupRegistryKey(keys: Iterable<string>, name: string): string | null {
  for (const key of keys) {
    if (key === name) return key
  }
  const lc = name.toLowerCase()
  for (const key of keys) {
    if (key.toLowerCase() === lc) return key
  }
  return null
}

/** Live connector entries (id + name) from the pool provider, or null when absent. */
function connectorEntries(host: AgentHost): Array<{ id: string; name: string }> | null {
  const pools = host.mssql.pools
  return pools ? Array.from(pools.list()) : null
}

export function listMssqlConnectionNames(host: AgentHost): string[] {
  const entries = connectorEntries(host)
  if (entries) return entries.map((e) => e.id)
  return Array.from(host.mssql.databases.keys())
}

function isDefaultConnectionToken(name: string | null | undefined): boolean {
  const t = (name ?? "").trim()
  return t.length === 0 || t.toLowerCase() === "default"
}

/**
 * Resolve any connection token to the canonical connector id (or registry key
 * for the legacy databases path). Throws when an explicit name is unknown or no
 * connections are configured.
 */
export function resolveMssqlConnectionName(host: AgentHost, name?: string | null): string {
  const entries = connectorEntries(host)
  if (entries) {
    if (entries.length === 0) {
      throw new Error("MSSQL not configured — no connectors enabled.")
    }
    const trimmed = (name ?? "").trim()
    if (!isDefaultConnectionToken(trimmed)) {
      // Primary: match by id (case-insensitive).
      const byId = entries.find((e) => e.id.toLowerCase() === trimmed.toLowerCase())
      if (byId) return byId.id
      // Ergonomic alias: match by connector name (case-insensitive).
      const byName = entries.find((e) => e.name.toLowerCase() === trimmed.toLowerCase())
      if (byName) return byName.id
      const available = entries.map((e) => e.id).join(", ")
      throw new Error(`MSSQL connection "${trimmed}" not configured. Available: ${available}.`)
    }
    const defaultId = host.mssql.defaultConnection.value
    if (defaultId) {
      const hit = entries.find((e) => e.id.toLowerCase() === defaultId.toLowerCase())
      if (hit) return hit.id
    }
    return entries[0]!.id
  }

  // Legacy databases-map path (tests).
  const keys = listMssqlConnectionNames(host)
  if (keys.length === 0) {
    throw new Error("MSSQL not configured — no database connections registered.")
  }

  const trimmed = (name ?? "").trim()
  if (!isDefaultConnectionToken(trimmed)) {
    const hit = lookupRegistryKey(keys, trimmed)
    if (hit) return hit
    throw new Error(
      `MSSQL connection "${trimmed}" not configured. Available: ${keys.join(", ")}.`
    )
  }

  const defaultName = host.mssql.defaultConnection.value
  if (defaultName) {
    const hit = lookupRegistryKey(keys, defaultName)
    if (hit) return hit
  }

  return keys[0]!
}

/** Resolve `connection` from a tool args object to the canonical connector id. */
export function resolveToolConnectionArg(host: AgentHost, args: Record<string, unknown>): string {
  const raw = args.connection != null && String(args.connection).trim()
    ? String(args.connection).trim()
    : null
  return resolveMssqlConnectionName(host, raw)
}

/** Non-throwing variant — returns null when resolution fails. */
export function tryResolveMssqlConnectionName(
  host: AgentHost,
  name?: string | null
): string | null {
  try {
    return resolveMssqlConnectionName(host, name)
  } catch {
    return null
  }
}

/** Normalize a configured default connection name at boot (env → connector id / registry key). */
export function canonicalizeConfiguredConnectionName(
  keys: Iterable<string>,
  name: string | null | undefined
): string | null {
  if (!name?.trim()) return null
  return lookupRegistryKey(keys, name.trim()) ?? name.trim()
}
