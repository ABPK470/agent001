/**
 * Environments registry — first-class wrapper around named MSSQL connections
 * for ABI sync.
 *
 * An environment is a named MSSQL connection (from MSSQL_DATABASES) that has
 * been tagged with a role (`source` / `target` / `both`), an optional
 * linked-server identifier (used for cross-server reads/writes), a display
 * colour, and a per-env sync allowlist.
 *
 * Loading priority:
 *   1. `deploy/mssql/sync-environments.json` if present — explicit config that
 *      maps each MSSQL_DATABASES connection to a sync env, pinning a
 *      `core.LinkedService.name` for the linked-service identifier.
 *   2. Else fall back to synthesising one entry per configured MSSQL connection
 *      with role `both`.
 *
 * At load time, `linkedServerName` is resolved automatically by querying
 * `core.LinkedService.properties.serverName` from the first available DB.
 * No need to maintain it in the config file.
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { getMssqlConfig, getPool } from "../tools/mssql/index.js"

export type EnvRole = "source" | "target" | "both"

export interface SyncEnvironment {
  /** Connection name (matches an MSSQL connection registered at startup). */
  name: string
  /** Human display name e.g. "Production". Falls back to `name`. */
  displayName: string
  /** Tailwind-friendly accent colour token e.g. "emerald", "amber". */
  color: string
  role: EnvRole
  /**
   * SQL Server linked-server identifier other environments use to read FROM
   * this one e.g. `MYMI_PROD`. Required for cross-server diff queries.
   * Auto-resolved from core.LinkedService.properties.serverName at startup.
   */
  linkedServerName: string | null
  /** Lower numbers deploy/sync first (0 = dev, 1 = uat, 2 = prod). */
  ringOrder: number
  /**
   * UPN allowlist for sync_execute on this environment. Empty = open to all
   * authenticated users. Cross-checked against `agent001_sid` cookie identity.
   */
  syncAllowlist: string[]
  /**
   * Optional core.LinkedService.name pinned by config — when set, the runtime
   * can resolve src/dest server+db pairs by reading that linked-service row.
   */
  linkedServiceName?: string | null
}

interface SyncEnvironmentsConfigFile {
  version: 1
  environments: Array<Partial<SyncEnvironment> & { name: string }>
}

const _envs = new Map<string, SyncEnvironment>()

/** Configure all environments at once. Replaces any prior config. */
export function setEnvironments(envs: SyncEnvironment[]): void {
  _envs.clear()
  for (const e of envs) _envs.set(e.name, e)
}

/** Read the current environment registry. */
export function getEnvironments(): SyncEnvironment[] {
  return Array.from(_envs.values())
}

/** Get one environment by name; throws if missing. */
export function getEnvironment(name: string): SyncEnvironment {
  const e = _envs.get(name)
  if (!e) {
    const available = Array.from(_envs.keys()).join(", ") || "none"
    throw new Error(`Unknown environment "${name}". Available: ${available}.`)
  }
  return e
}

const DEFAULT_CONFIG_PATH = "deploy/mssql/sync-environments.json"

/**
 * Initialise environments. Reads `deploy/mssql/sync-environments.json` if
 * present; otherwise synthesises one entry per configured MSSQL connection.
 * Then resolves `linkedServerName` from `core.LinkedService` automatically.
 */
export async function setupEnvironments(projectRoot: string, relPath = DEFAULT_CONFIG_PATH): Promise<string> {
  const configPath = resolve(projectRoot, relPath)
  let envs: SyncEnvironment[]

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8")
      const parsed = JSON.parse(raw) as SyncEnvironmentsConfigFile
      if (parsed.version !== 1) throw new Error(`Unsupported version: ${parsed.version}`)
      envs = parsed.environments.map((e) => ({
        name: e.name,
        displayName: e.displayName ?? e.name,
        color: e.color ?? "slate",
        role: (e.role ?? "both") as EnvRole,
        linkedServerName: e.linkedServerName ?? null,
        ringOrder: typeof e.ringOrder === "number" ? e.ringOrder : 0,
        syncAllowlist: Array.isArray(e.syncAllowlist) ? e.syncAllowlist : [],
        linkedServiceName: e.linkedServiceName ?? null,
      }))
      setEnvironments(envs)
      const summary = envs.map((e) => `${e.name}[${e.role}]`).join(", ")
      console.log(`ABI environments (from ${relPath}): ${summary}`)
    } catch (e) {
      console.error(`Invalid ${relPath}:`, e instanceof Error ? e.message : e)
      envs = []
    }
  } else {
    // Fallback — one env per configured MSSQL connection, role=both.
    const FALLBACK_PALETTE = ["blue", "teal", "indigo", "pink", "slate", "cyan"]
    const conns = getMssqlConfig()
    envs = conns.map((c: { name: string }, i: number) => ({
      name: c.name,
      displayName: c.name,
      color: FALLBACK_PALETTE[i % FALLBACK_PALETTE.length] ?? "slate",
      role: "both" as EnvRole,
      linkedServerName: null,
      ringOrder: i,
      syncAllowlist: [],
      linkedServiceName: null,
    }))
    setEnvironments(envs)
    if (envs.length) {
      console.log(`ABI environments (auto from MSSQL_DATABASES): ${envs.map((e) => e.name).join(", ")}`)
    }
  }

  // Resolve linkedServerName from core.LinkedService in one shot.
  await resolveLinkedServerNames(envs)

  return envs.map((e) => `${e.name}[${e.role}]`).join(", ")
}

/**
 * For each env that has a `linkedServiceName` but no `linkedServerName`,
 * query `core.LinkedService` to fill in the server name. Uses the first
 * available env as the DB connection. Non-fatal on failure.
 */
async function resolveLinkedServerNames(envs: SyncEnvironment[]): Promise<void> {
  const needs = envs.filter((e) => e.linkedServiceName && !e.linkedServerName)
  if (needs.length === 0) return
  // Use the first env's own connection to query core.LinkedService.
  const connName = envs[0]?.name
  if (!connName) return
  try {
    const { pool } = await getPool(connName)
    const result = await pool.request().query(`
      SELECT name, properties
      FROM core.LinkedService
      WHERE name IN (${needs.map((e) => `N'${(e.linkedServiceName ?? "").replace(/'/g, "''")}'`).join(",")})
        AND validTo IS NULL
    `)
    const byName = new Map<string, string>()
    for (const row of result.recordset as Array<{ name: string; properties: string }>) {
      try {
        const props = JSON.parse(row.properties)
        if (props?.serverName) byName.set(row.name, String(props.serverName))
      } catch { /* ignore malformed JSON */ }
    }
    for (const e of needs) {
      const ls = byName.get(e.linkedServiceName ?? "")
      if (ls) e.linkedServerName = ls
    }
    if (byName.size) console.log(`Resolved linked-server names from core.LinkedService: ${[...byName.entries()].map(([k, v]) => `${k}→${v}`).join(", ")}`)
  } catch (e) {
    console.warn(`Could not resolve linked-server names from core.LinkedService: ${e instanceof Error ? e.message : e}`)
  }
}
