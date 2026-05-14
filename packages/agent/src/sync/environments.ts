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
import { currentRuntime } from "../agent-runtime.js"
import { getMssqlConfig, getPool } from "../tools/index.js"

export type EnvRole = "source" | "target" | "both"

/**
 * Per-environment access mode. UAT and PROD default to `read_only` so a
 * fresh deployment cannot mutate either accidentally; explicit operator
 * config in `deploy/mssql/sync-environments.json` is the only way to
 * widen the default.
 */
export type EnvAccessMode = "read_only" | "read_write"

/**
 * Operation classes the policy engine knows about. Mirror of
 * {@link PolicyDbOperation} in `packages/agent/src/engine/policy-selectors.ts` —
 * kept as a string-literal alias here so this module doesn't pull in the
 * agent engine just for the type.
 */
export type EnvOperation =
  | "query_read"
  | "schema_introspect"
  | "sync_preview"
  | "sync_execute"
  | "ddl"
  | "dml"

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
   * authenticated users. Cross-checked against `mia_sid` cookie identity.
   */
  syncAllowlist: string[]
  /**
   * Optional core.LinkedService.name pinned by config — when set, the runtime
   * can resolve src/dest server+db pairs by reading that linked-service row.
   */
  linkedServiceName?: string | null

  // ── Hosted-mode access control ────────────────────────────────
  /**
   * Default access mode for this environment. UAT and PROD default to
   * `read_only`; DEV defaults to `read_write`. The hosted policy engine
   * derives concrete deny rules from this field via
   * {@link policyRulesFromEnvironments}.
   */
  defaultAccessMode: EnvAccessMode
  /**
   * Operations explicitly allowed on this environment. When set, anything
   * NOT in this list AND not allowed elsewhere is denied. Empty/undefined
   * means "use the defaults derived from `defaultAccessMode` + the
   * `denyDml` / `denyDdl` flags".
   */
  allowedOperations: EnvOperation[]
  /** Convenience: deny DML (insert/update/delete/merge/truncate). */
  denyDml: boolean
  /** Convenience: deny DDL (create/alter/drop/grant/revoke). */
  denyDdl: boolean
  /**
   * Operations that, when reached, must surface an approval prompt. Default
   * `["sync_execute"]` for read-only envs.
   */
  approvalRequiredOperations: EnvOperation[]
}

interface SyncEnvironmentsConfigFile {
  version: 1
  environments: Array<Partial<SyncEnvironment> & { name: string }>
}

// Environment registry lives on the active AgentRuntime
// (`currentRuntime().sync.environments`).

/** Configure all environments at once. Replaces any prior config. */
export function setEnvironments(envs: SyncEnvironment[]): void {
  currentRuntime().sync.environments.clear()
  for (const e of envs) currentRuntime().sync.environments.set(e.name, e)
}

/** Read the current environment registry. */
export function getEnvironments(): SyncEnvironment[] {
  return Array.from(currentRuntime().sync.environments.values())
}

/** Get one environment by name; throws if missing. */
export function getEnvironment(name: string): SyncEnvironment {
  const e = currentRuntime().sync.environments.get(name)
  if (!e) {
    const available = Array.from(currentRuntime().sync.environments.keys()).join(", ") || "none"
    throw new Error(`Unknown environment "${name}". Available: ${available}.`)
  }
  return e
}

// ── Permission defaults ──────────────────────────────────────────

/**
 * Apply hosted-mode safety defaults to a partial environment record.
 * UAT/PROD are read-only with DML+DDL denied; DEV is read-write. These
 * defaults are intentionally conservative — operators widen them by
 * explicitly setting the corresponding fields in
 * `deploy/mssql/sync-environments.json`.
 */
export function withPermissionDefaults(
  e: Partial<SyncEnvironment> & Pick<SyncEnvironment, "name">,
): SyncEnvironment {
  // Treat anything containing "prod" or "uat" (case-insensitive) as
  // read-only by default. Everything else is treated as dev-shaped.
  const isProdLike = /\bprod\b/i.test(e.name)
  const isUatLike  = /\buat\b|\bstag(e|ing)?\b/i.test(e.name)
  const lockedDown = isProdLike || isUatLike
  const defaultAccessMode: EnvAccessMode = e.defaultAccessMode ?? (lockedDown ? "read_only" : "read_write")
  const denyDml = e.denyDml ?? (defaultAccessMode === "read_only")
  const denyDdl = e.denyDdl ?? (defaultAccessMode === "read_only")
  const allowedOperations = e.allowedOperations ?? (
    lockedDown
      ? ["query_read", "schema_introspect", "sync_preview"] as EnvOperation[]
      : ["query_read", "schema_introspect", "sync_preview", "sync_execute", "dml"] as EnvOperation[]
  )
  const approvalRequiredOperations = e.approvalRequiredOperations ?? (["sync_execute"] as EnvOperation[])

  return {
    name:               e.name,
    displayName:        e.displayName ?? e.name,
    color:              e.color ?? "slate",
    role:               (e.role ?? "both") as EnvRole,
    linkedServerName:   e.linkedServerName ?? null,
    ringOrder:          typeof e.ringOrder === "number" ? e.ringOrder : 0,
    syncAllowlist:      Array.isArray(e.syncAllowlist) ? e.syncAllowlist : [],
    linkedServiceName:  e.linkedServiceName ?? null,
    defaultAccessMode,
    allowedOperations,
    denyDml,
    denyDdl,
    approvalRequiredOperations,
  }
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
      envs = parsed.environments.map((e) => withPermissionDefaults({
        name: e.name,
        displayName: e.displayName ?? e.name,
        color: e.color ?? "slate",
        role: (e.role ?? "both") as EnvRole,
        linkedServerName: e.linkedServerName ?? null,
        ringOrder: typeof e.ringOrder === "number" ? e.ringOrder : 0,
        syncAllowlist: Array.isArray(e.syncAllowlist) ? e.syncAllowlist : [],
        linkedServiceName: e.linkedServiceName ?? null,
        defaultAccessMode: e.defaultAccessMode,
        allowedOperations: e.allowedOperations,
        denyDml: e.denyDml,
        denyDdl: e.denyDdl,
        approvalRequiredOperations: e.approvalRequiredOperations,
      }))
      setEnvironments(envs)
      const summary = envs.map((e) => `${e.name}[${e.role}/${e.defaultAccessMode}]`).join(", ")
      console.log(`ABI environments (from ${relPath}): ${summary}`)
    } catch (e) {
      console.error(`Invalid ${relPath}:`, e instanceof Error ? e.message : e)
      envs = []
    }
  } else {
    // Fallback — one env per configured MSSQL connection, role=both.
    const FALLBACK_PALETTE = ["blue", "teal", "indigo", "pink", "slate", "cyan"]
    const conns = getMssqlConfig()
    envs = conns.map((c: { name: string }, i: number) => withPermissionDefaults({
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
      console.log(`ABI environments (auto from MSSQL_DATABASES): ${envs.map((e) => `${e.name}[${e.defaultAccessMode}]`).join(", ")}`)
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
