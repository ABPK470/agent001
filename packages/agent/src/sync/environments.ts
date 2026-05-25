/**
 * Environments registry — first-class wrapper around named MSSQL connections
 * for ABI sync.
 *
 * An environment is a named MSSQL connection (from MSSQL_DATABASES) that has
 * been tagged with a role (`source` / `target` / `both`), a display colour,
 * and a per-env sync allowlist.
 *
 * Loading priority:
 *   1. `deploy/mssql/sync-environments.json` if present — explicit config that
 *      maps each MSSQL_DATABASES connection to a sync env.
 *   2. Else fall back to synthesising one entry per configured MSSQL connection
 *      with role `both`.
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { EnvAccessMode, EnvRole } from "../domain/enums/sync.js"
import type { AgentHost } from "../host/index.js"
import { getMssqlConfig } from "../tools/index.js"

export type { EnvAccessMode, EnvRole }

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
  /** Lower numbers deploy/sync first (0 = dev, 1 = uat, 2 = prod). */
  ringOrder: number
  /**
   * Direct base URL of the MyMI Agent service for this environment, used for
   * trigger re-registration after contract sync. Example:
   * `http://host:5010/agent`.
   */
  agentServiceBaseUrl?: string | null
  /**
   * UPN allowlist for sync_execute on this environment. Empty = open to all
   * authenticated users. Cross-checked against `mia_sid` cookie identity.
   */
  syncAllowlist: string[]
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

// Environment registry lives on the host sync state (`host.sync.environments`).

/** Configure all environments at once. Replaces any prior config. */
export function setEnvironments(host: AgentHost, envs: SyncEnvironment[]): void {
  host.sync.environments.clear()
  for (const e of envs) host.sync.environments.set(e.name, e)
}

/** Read the current environment registry. */
export function getEnvironments(host: AgentHost): SyncEnvironment[] {
  return Array.from(host.sync.environments.values())
}

/** Get one environment by name; throws if missing. */
export function getEnvironment(host: AgentHost, name: string): SyncEnvironment {
  const e = host.sync.environments.get(name)
  if (!e) {
    const available = Array.from(host.sync.environments.keys()).join(", ") || "none"
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
  const defaultAccessMode: EnvAccessMode = e.defaultAccessMode ?? (lockedDown ? EnvAccessMode.ReadOnly : EnvAccessMode.ReadWrite)
  const denyDml = e.denyDml ?? (defaultAccessMode === EnvAccessMode.ReadOnly)
  const denyDdl = e.denyDdl ?? (defaultAccessMode === EnvAccessMode.ReadOnly)
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
    role:               (e.role ?? EnvRole.Both),
    ringOrder:          typeof e.ringOrder === "number" ? e.ringOrder : 0,
    agentServiceBaseUrl:e.agentServiceBaseUrl ?? null,
    syncAllowlist:      Array.isArray(e.syncAllowlist) ? e.syncAllowlist : [],
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
 */
export async function setupEnvironments(host: AgentHost, projectRoot: string, relPath = DEFAULT_CONFIG_PATH): Promise<string> {
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
        role: (e.role ?? EnvRole.Both),
        ringOrder: typeof e.ringOrder === "number" ? e.ringOrder : 0,
        agentServiceBaseUrl: e.agentServiceBaseUrl ?? null,
        syncAllowlist: Array.isArray(e.syncAllowlist) ? e.syncAllowlist : [],
        defaultAccessMode: e.defaultAccessMode,
        allowedOperations: e.allowedOperations,
        denyDml: e.denyDml,
        denyDdl: e.denyDdl,
        approvalRequiredOperations: e.approvalRequiredOperations,
      }))
      setEnvironments(host, envs)
      const summary = envs.map((e) => `${e.name}[${e.role}/${e.defaultAccessMode}]`).join(", ")
      console.log(`ABI environments (from ${relPath}): ${summary}`)
    } catch (e) {
      console.error(`Invalid ${relPath}:`, e instanceof Error ? e.message : e)
      envs = []
    }
  } else {
    // Fallback — one env per configured MSSQL connection, role=both.
    const FALLBACK_PALETTE = ["blue", "teal", "indigo", "pink", "slate", "cyan"]
    const conns = getMssqlConfig(host)
    envs = conns.map((c: { name: string }, i: number) => withPermissionDefaults({
      name: c.name,
      displayName: c.name,
      color: FALLBACK_PALETTE[i % FALLBACK_PALETTE.length] ?? "slate",
      role: EnvRole.Both,
      ringOrder: i,
      syncAllowlist: [],
    }))
    setEnvironments(host, envs)
    if (envs.length) {
      console.log(`ABI environments (auto from MSSQL_DATABASES): ${envs.map((e) => `${e.name}[${e.defaultAccessMode}]`).join(", ")}`)
    }
  }

  return envs.map((e) => `${e.name}[${e.role}]`).join(", ")
}
