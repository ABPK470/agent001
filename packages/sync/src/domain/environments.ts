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
import { getMssqlConfig, type AgentHost } from "../ports/index.js"
import { EnvAccessMode, EnvRole } from "./enums.js"

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
   * Direct base URL of the MyMI ETL service for this environment, used for
   * dataset/rule deployment callbacks after metadata sync. Example:
   * `http://host:5005/etl`.
   */
  etlServiceBaseUrl?: string | null
  /**
   * Direct base URL of the MyMI Gate service for this environment, used for
   * gate metadata refresh callbacks after metadata sync. Example:
   * `https://host/gate`.
   */
  gateServiceBaseUrl?: string | null
  /**
   * UPN allowlist for sync_execute on this environment. Empty = open to all
   * authenticated users. Cross-checked against `mia_sid` cookie identity.
   */
  syncAllowlist: string[]
  /**
   * Optional explicit list of allowed sync targets when this environment is
   * used as the source. `null` means unrestricted by direction policy; an
   * empty array means no sync targets are currently allowed.
   */
  allowedSyncTargets: string[] | null
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
   * Legacy hosted-policy field preserved for backward compatibility.
   * Sync approvals should be configured through the dedicated approval
   * workflow, not per-environment tool gates.
   */
  approvalRequiredOperations: EnvOperation[]
}

interface SyncEnvironmentsConfigFile {
  version: 1
  environments: Array<Partial<SyncEnvironment> & { name: string }>
}

export interface LoadSyncEnvironmentsResult {
  environments: SyncEnvironment[]
  summary: string
  source: "file" | "mssql" | "none"
}

// Environment registry lives on the supplied host.

/** Configure all environments at once. Replaces any prior config. */
export function replaceEnvironments(host: AgentHost, envs: SyncEnvironment[]): void {
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

/**
 * Temporary hard guard for live ABI sync usage: the only supported
 * direction is UAT -> DEV. Keep this centralized so preview and execute
 * fail the same way.
 */
export function assertSupportedSyncDirection(sourceEnv: SyncEnvironment, targetEnv: SyncEnvironment): void {
  const allowedTargets = sourceEnv.allowedSyncTargets
  if (allowedTargets === null) return
  const target = targetEnv.name.trim().toLowerCase()
  const normalized = allowedTargets.map((name) => name.trim().toLowerCase())
  if (normalized.includes(target)) return
  const rendered = allowedTargets.length > 0 ? allowedTargets.join(", ") : "none"
  throw new Error(
    `Unsupported sync direction "${sourceEnv.name} -> ${targetEnv.name}". Allowed targets for ${sourceEnv.name}: ${rendered}.`,
  )
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
  const approvalRequiredOperations = e.approvalRequiredOperations ?? ([] as EnvOperation[])

  return {
    name:               e.name,
    displayName:        e.displayName ?? e.name,
    color:              e.color ?? "slate",
    role:               (e.role ?? EnvRole.Both),
    ringOrder:          typeof e.ringOrder === "number" ? e.ringOrder : 0,
    agentServiceBaseUrl:e.agentServiceBaseUrl ?? null,
    etlServiceBaseUrl:  e.etlServiceBaseUrl ?? null,
    gateServiceBaseUrl: e.gateServiceBaseUrl ?? null,
    syncAllowlist:      Array.isArray(e.syncAllowlist) ? e.syncAllowlist : [],
    allowedSyncTargets: Array.isArray(e.allowedSyncTargets) ? e.allowedSyncTargets.map(String) : null,
    defaultAccessMode,
    allowedOperations,
    denyDml,
    denyDdl,
    approvalRequiredOperations,
  }
}

const DEFAULT_CONFIG_PATH = "deploy/mssql/sync-environments.json"

export function loadSyncEnvironments(
  projectRoot: string,
  connections: ReadonlyArray<{ name: string }>,
  relPath = DEFAULT_CONFIG_PATH,
): LoadSyncEnvironmentsResult {
  const configPath = resolve(projectRoot, relPath)

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8")
      const parsed = JSON.parse(raw) as SyncEnvironmentsConfigFile
      if (parsed.version !== 1) throw new Error(`Unsupported version: ${parsed.version}`)
      const environments = parsed.environments.map((e) => withPermissionDefaults({
        name: e.name,
        displayName: e.displayName ?? e.name,
        color: e.color ?? "slate",
        role: (e.role ?? EnvRole.Both),
        ringOrder: typeof e.ringOrder === "number" ? e.ringOrder : 0,
        agentServiceBaseUrl: e.agentServiceBaseUrl ?? null,
        etlServiceBaseUrl: e.etlServiceBaseUrl ?? null,
        gateServiceBaseUrl: e.gateServiceBaseUrl ?? null,
        syncAllowlist: Array.isArray(e.syncAllowlist) ? e.syncAllowlist : [],
        allowedSyncTargets: Array.isArray(e.allowedSyncTargets) ? e.allowedSyncTargets.map(String) : null,
        defaultAccessMode: e.defaultAccessMode,
        allowedOperations: e.allowedOperations,
        denyDml: e.denyDml,
        denyDdl: e.denyDdl,
        approvalRequiredOperations: e.approvalRequiredOperations,
      }))
      return {
        environments,
        summary: environments.map((env) => `${env.name}[${env.role}/${env.defaultAccessMode}]`).join(", "),
        source: "file",
      }
    } catch (e) {
      console.error(`Invalid ${relPath}:`, e instanceof Error ? e.message : e)
      return { environments: [], summary: "", source: "none" }
    }
  }

  const FALLBACK_PALETTE = ["blue", "teal", "indigo", "pink", "slate", "cyan"]
  const environments = connections.map((connection, i) => withPermissionDefaults({
    name: connection.name,
    displayName: connection.name,
    color: FALLBACK_PALETTE[i % FALLBACK_PALETTE.length] ?? "slate",
    role: EnvRole.Both,
    ringOrder: i,
    syncAllowlist: [],
  }))
  return {
    environments,
    summary: environments.map((env) => `${env.name}[${env.defaultAccessMode}]`).join(", "),
    source: environments.length ? "mssql" : "none",
  }
}

/**
 * Initialise environments. Reads `deploy/mssql/sync-environments.json` if
 * present; otherwise synthesises one entry per configured MSSQL connection.
 */
export async function setupEnvironments(host: AgentHost, projectRoot: string, relPath = DEFAULT_CONFIG_PATH): Promise<string> {
  const loaded = loadSyncEnvironments(projectRoot, getMssqlConfig(host), relPath)
  replaceEnvironments(host, loaded.environments)
  if (loaded.source === "file") {
    console.log(`ABI environments (from ${relPath}): ${loaded.summary}`)
  } else if (loaded.source === "mssql") {
    console.log(`ABI environments (auto from MSSQL_DATABASES): ${loaded.summary}`)
  }
  return loaded.environments.map((env) => `${env.name}[${env.role}]`).join(", ")
}
