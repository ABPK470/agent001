/**
 * Environment normalize / direction / removed-field guards — pure decisions.
 */
import {
  REMOVED_SYNC_ENVIRONMENT_FIELDS,
  type EnvOperation,
  type RemovedSyncEnvironmentField,
  type SyncEnvironment
} from "../../domain/environments.js"
import { EnvAccessMode, EnvRole } from "../../domain/enums.js"
import { mergeServiceUrlFields, normalizeServiceUrls } from "./env-service-urls.js"

export function removedSyncEnvironmentFieldError(field: string, label = "request"): string {
  return `${label}: removed field "${field}" is no longer supported — use hosted policy (defaultAccessMode, allowedOperations) and approvals instead of per-environment UPN lists.`
}

export function findRemovedSyncEnvironmentFields(
  source: Record<string, unknown>
): RemovedSyncEnvironmentField[] {
  return REMOVED_SYNC_ENVIRONMENT_FIELDS.filter(
    (field) => field in source && source[field] !== undefined
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
  raw: Record<string, unknown>
): SyncEnvironment {
  return withPermissionDefaults({
    ...(raw as Partial<SyncEnvironment>),
    name
  })
}

/**
 * Outgoing direction policy on the source environment.
 * `allowedSyncEnvironments === null` → unrestricted; `[]` → blocked.
 * Role and connector readiness are asserted separately (see sync-env-eligibility).
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

/**
 * Apply hosted-mode safety defaults to a partial environment record.
 * UAT/PROD are read-only with DML+DDL denied; DEV is read-write.
 */
export function withPermissionDefaults(
  e: Partial<SyncEnvironment> & Pick<SyncEnvironment, "name">
): SyncEnvironment {
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
      : ([
          "query_read",
          "schema_introspect",
          "sync_preview",
          "sync_execute",
          "dml",
          "sync_custom_sql",
          "sync_shell_execute"
        ] as EnvOperation[]))
  const approvalRequiredOperations = e.approvalRequiredOperations ?? ([] as EnvOperation[])

  const serviceUrls = mergeServiceUrlFields({
    serviceUrls: normalizeServiceUrls(e.serviceUrls as Record<string, unknown> | undefined),
    agentServiceBaseUrl: e.agentServiceBaseUrl ?? null,
    etlServiceBaseUrl: e.etlServiceBaseUrl ?? null,
    gateServiceBaseUrl: e.gateServiceBaseUrl ?? null
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
