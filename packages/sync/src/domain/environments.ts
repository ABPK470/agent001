/**
 * Environments registry — first-class wrapper around named MSSQL connections
 * for ABI sync.
 *
 * An environment is a named MSSQL connection (from MSSQL_DATABASES) that has
 * been tagged with a role (`source` / `target` / `both`), a display colour,
 * and a display colour.
 *
 * Disk/MSSQL loaders live in `runtime/environments.ts`.
 */

import { mergeServiceUrlFields, normalizeServiceUrls } from "./env-service-urls.js"
import type { SyncEnvironmentRegistryHost } from "../ports/index.js"
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
  | "sync_custom_sql"
  | "sync_shell_execute"
  | "ddl"
  | "dml"

export interface SyncEnvironment {
  /** Connection name (matches an MSSQL connection registered at startup). */
  name: string
  /**
   * Foreign key to a persisted MSSQL connector — the real link used to resolve
   * the sync run's connection pool (live, via the MSSQL pool provider). Validated
   * as a required, live FK on create/update; pool resolution throws loudly if
   * absent. The environment `name` is a free-form slug, no longer required to
   * match a boot-time connection name.
   */
  connectorId?: string | null
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
   * Named HTTP service base URLs for this environment (e.g. agent, etl, gate, or custom).
   * When set, takes precedence over the legacy *ServiceBaseUrl fields for matching keys.
   */
  serviceUrls?: Record<string, string | null>
  /**
   * Optional explicit list of allowed sync environments when this environment is
   * used as the source. `null` means unrestricted by direction policy; an
   * empty array means no sync environments are currently allowed.
   */
  allowedSyncEnvironments: string[] | null
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

export interface LoadSyncEnvironmentsResult {
  environments: SyncEnvironment[]
  summary: string
  source: "file" | "mssql" | "none"
}

/** Legacy fields removed from SyncEnvironment — rejected on API/config ingest. */
export const REMOVED_SYNC_ENVIRONMENT_FIELDS = ["syncAllowlist"] as const

export type RemovedSyncEnvironmentField = (typeof REMOVED_SYNC_ENVIRONMENT_FIELDS)[number]

export function removedSyncEnvironmentFieldError(field: string, label = "request"): string {
  return `${label}: removed field "${field}" is no longer supported — use hosted policy (defaultAccessMode, allowedOperations) and approvals instead of per-environment UPN lists.`
}

export function findRemovedSyncEnvironmentFields(
  source: Record<string, unknown>,
): RemovedSyncEnvironmentField[] {
  return REMOVED_SYNC_ENVIRONMENT_FIELDS.filter(
    (field) => field in source && source[field] !== undefined,
  )
}

export function assertNoRemovedSyncEnvironmentFields(source: Record<string, unknown>, label: string): void {
  const found = findRemovedSyncEnvironmentFields(source)
  if (found.length > 0) {
    throw new Error(removedSyncEnvironmentFieldError(found[0]!, label))
  }
}

/** Strip legacy keys and apply permission defaults — use on every DB read/write. */
export function normalizeStoredSyncEnvironment(
  name: string,
  raw: Record<string, unknown>,
): SyncEnvironment {
  return withPermissionDefaults({
    ...(raw as Partial<SyncEnvironment>),
    name,
  })
}

// Environment registry lives on the supplied host.

/** Configure all environments at once. Replaces any prior config. */
export function replaceEnvironments(host: SyncEnvironmentRegistryHost, envs: SyncEnvironment[]): void {
  host.sync.environments.items.clear()
  for (const e of envs) host.sync.environments.items.set(e.name, e)
}

/** Read the current environment registry. */
export function getEnvironments(host: SyncEnvironmentRegistryHost): SyncEnvironment[] {
  return Array.from(host.sync.environments.items.values())
}

/** Get one environment by name; throws if missing. */
export function getEnvironment(host: SyncEnvironmentRegistryHost, name: string): SyncEnvironment {
  const e = host.sync.environments.items.get(name)
  if (!e) {
    const available = Array.from(host.sync.environments.items.keys()).join(", ") || "none"
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
  const allowedConnections = sourceEnv.allowedSyncEnvironments
  if (allowedConnections === null) return
  const target = targetEnv.name.trim().toLowerCase()
  const normalized = allowedConnections.map((name) => name.trim().toLowerCase())
  if (normalized.includes(target)) return
  const rendered = allowedConnections.length > 0 ? allowedConnections.join(", ") : "none"
  throw new Error(
    `Unsupported sync direction "${sourceEnv.name} -> ${targetEnv.name}". Allowed connections for ${sourceEnv.name}: ${rendered}.`
  )
}

// ── Permission defaults ──────────────────────────────────────────

/**
 * Apply hosted-mode safety defaults to a partial environment record.
 * UAT/PROD are read-only with DML+DDL denied; DEV is read-write. These
 * defaults are intentionally conservative — operators widen them by
 * explicitly setting the corresponding fields in
 * `deploy/sync/sync-environments.json`.
 */
export function withPermissionDefaults(
  e: Partial<SyncEnvironment> & Pick<SyncEnvironment, "name">
): SyncEnvironment {
  // Treat anything containing "prod" or "uat" (case-insensitive) as
  // read-only by default. Everything else is treated as dev-shaped.
  const isProdLike = /\bprod\b/i.test(e.name)
  const isUatLike = /\buat\b|\bstag(e|ing)?\b/i.test(e.name)
  const lockedDown = isProdLike || isUatLike
  const defaultAccessMode: EnvAccessMode =
    e.defaultAccessMode ?? (lockedDown ? EnvAccessMode.ReadOnly : EnvAccessMode.ReadWrite)
  const denyDml = e.denyDml ?? defaultAccessMode === EnvAccessMode.ReadOnly
  const denyDdl = e.denyDdl ?? defaultAccessMode === EnvAccessMode.ReadOnly
  const allowedOperations =
    e.allowedOperations ??
    (lockedDown
      ? (["query_read", "schema_introspect", "sync_preview"] as EnvOperation[])
      : (["query_read", "schema_introspect", "sync_preview", "sync_execute", "dml", "sync_custom_sql", "sync_shell_execute"] as EnvOperation[]))
  const approvalRequiredOperations = e.approvalRequiredOperations ?? ([] as EnvOperation[])

  const serviceUrls = mergeServiceUrlFields({
    serviceUrls: normalizeServiceUrls(e.serviceUrls as Record<string, unknown> | undefined),
    agentServiceBaseUrl: e.agentServiceBaseUrl ?? null,
    etlServiceBaseUrl: e.etlServiceBaseUrl ?? null,
    gateServiceBaseUrl: e.gateServiceBaseUrl ?? null,
  })

  const rawLegacy = e as Record<string, unknown>
  const allowedSyncEnvironments = Array.isArray(e.allowedSyncEnvironments)
    ? e.allowedSyncEnvironments.map(String)
    : Array.isArray(rawLegacy.allowedSyncConnections)
      ? (rawLegacy.allowedSyncConnections as unknown[]).map(String)
      : Array.isArray(rawLegacy.allowedSyncTargets)
        ? (rawLegacy.allowedSyncTargets as unknown[]).map(String)
        : null

  return {
    name: e.name,
    connectorId: e.connectorId ?? null,
    displayName: e.displayName ?? e.name,
    color: e.color ?? "slate",
    role: e.role ?? EnvRole.Both,
    ringOrder: typeof e.ringOrder === "number" ? e.ringOrder : 0,
    agentServiceBaseUrl: serviceUrls.agent ?? null,
    etlServiceBaseUrl: serviceUrls.etl ?? null,
    gateServiceBaseUrl: serviceUrls.gate ?? null,
    serviceUrls,
    allowedSyncEnvironments,
    defaultAccessMode,
    allowedOperations,
    denyDml,
    denyDdl,
    approvalRequiredOperations
  }
}
