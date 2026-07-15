/**
 * Canonical MSSQL connection name resolution.
 *
 * User/env/tool input may be dev, DEV, Dev, or omitted — internally we always
 * use the single registry key from MSSQL_DATABASES / configureAgent.
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

export function listMssqlConnectionNames(host: AgentHost): string[] {
  return Array.from(host.mssql.databases.keys())
}

function isDefaultConnectionToken(name: string | null | undefined): boolean {
  const t = (name ?? "").trim()
  return t.length === 0 || t.toLowerCase() === "default"
}

/**
 * Resolve any connection token to the canonical registry key.
 * Throws when an explicit name is unknown or no connections are configured.
 */
export function resolveMssqlConnectionName(host: AgentHost, name?: string | null): string {
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

/** Resolve `connection` from a tool args object to the canonical registry key. */
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

/** Normalize a configured default connection name at boot (env → registry key). */
export function canonicalizeConfiguredConnectionName(
  keys: Iterable<string>,
  name: string | null | undefined
): string | null {
  if (!name?.trim()) return null
  return lookupRegistryKey(keys, name.trim()) ?? name.trim()
}
