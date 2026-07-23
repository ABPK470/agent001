/**
 * Environments vocabulary — shapes and removed-field constants.
 * Pure normalize / direction / permission defaults live in `core/eligibility/environments`.
 * Host Map accessors live in `runtime/environments-registry`.
 */

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
   * `read_only`; DEV defaults to `read_write`. Used by sync orchestration
   * gates (`assertEnvOperationAllowed`); allow/deny/approve for agent and
   * HTTP Sync tools live in Policies (`deploy/policies/defaults.json` + UI).
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

// Re-export EnvAccessMode/EnvRole usage for consumers that imported shapes from here
export type { EnvAccessMode, EnvRole }
